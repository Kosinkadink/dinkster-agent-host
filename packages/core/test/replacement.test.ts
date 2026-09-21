/**
 * Deprecation + replacement engine tests. The contract under test:
 * - rules are validated DATA; the last case must be unconditional
 * - registry layers rules schema > pack > core, appending within a layer
 * - guards read document state only (values, links, net sinks)
 * - planning is pure; errors mean NO plan, warnings mean review-required
 * - unmapped connections are dropped EXPLICITLY (never silently)
 * - dynamic member connections are invisible to rules and always dropped
 * - node.replace applies a plan as ONE atomic, undoable transaction and
 *   rejects stale plans without mutating anything
 */
import { describe, expect, it } from 'vitest'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { comfyGroupReplacementInvocation } from '../src/commands/replace-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import type { GraphDef, Json, WorkflowDocument } from '../src/format/document.js'
import { netViewPositions } from '../src/format/net-views.js'
import {
  asDynamicMemberId,
  asGraphDefId,
  asLineageId,
  asLinkId,
  asNetId,
  asNodeId,
  asPortId,
} from '../src/ids.js'
import { checkDocument } from '../src/invariants.js'
import { isReplacementRule, type ReplacementRule } from '../src/replace/model.js'
import { planReplacement, type NodeReplacePlan } from '../src/replace/plan.js'
import { createReplacementRegistry } from '../src/replace/registry.js'
import { REPLACEMENT_CHAIN_LIMIT, registerSchemaRules, replacementInvocation, scanReplacements } from '../src/replace/scan.js'
import { parseComfyReplacement } from '../src/schema/comfy-registry-codec.js'
import type { InputSpec, NodeSchema, OutputSpec, TypeExpr } from '../src/schema/model.js'

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const IMAGE: TypeExpr = { kind: 'concrete', name: 'IMAGE' }

const port = (node: string, portId: string) => ({ node: asNodeId(node), port: asPortId(portId) })
const mport = (node: string, portId: string, member: string) => ({
  node: asNodeId(node),
  port: asPortId(portId),
  members: [asDynamicMemberId(member)],
})

const input = (id: string, extra?: Partial<InputSpec>): InputSpec => ({
  kind: 'input',
  id,
  type: IMAGE,
  optional: false,
  ...extra,
})
const widgetInput = (id: string, dflt?: unknown, extra?: Partial<InputSpec>): InputSpec => ({
  kind: 'input',
  id,
  type: { kind: 'concrete', name: 'FLOAT' },
  optional: false,
  widget: { widgetType: 'number', options: {}, ...(dflt !== undefined ? { default: dflt } : {}) },
  ...extra,
})
const output = (id: string): OutputSpec => ({ kind: 'output', id, type: IMAGE })

const schemaOf = (type: string, items: (InputSpec | OutputSpec)[]): NodeSchema => ({
  type,
  displayName: type,
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  items,
})

/** Old node: image in, strength widget, image out. */
const schemas: Record<string, NodeSchema> = {
  TapOld: schemaOf('TapOld', [widgetInput('amount', 0.5)]),
  TapSame: schemaOf('TapSame', [widgetInput('amount', 1)]),
  TapSameReordered: schemaOf('TapSameReordered', [widgetInput('amount', 1, {
    type: { name: 'FLOAT', kind: 'concrete' },
  })]),
  TapAmbiguous: schemaOf('TapAmbiguous', [widgetInput('amount', 1), widgetInput('amount', 2)]),
  TapWrongType: schemaOf('TapWrongType', [widgetInput('amount', 1, { type: IMAGE })]),
  TapForced: schemaOf('TapForced', [widgetInput('amount', 1, { forceInput: true })]),
  TapDynamic: schemaOf('TapDynamic', [widgetInput('amount', 1, {
    dynamic: { kind: 'dynamicCombo', options: [{ key: 'one', inputs: [widgetInput('amount', 1)] }] },
  })]),
  TapMaskOld: schemaOf('TapMaskOld', [widgetInput('amount', 0.5, { type: { kind: 'concrete', name: 'dinkster.mask' } })]),
  TapMaskComfy: schemaOf('TapMaskComfy', [widgetInput('amount', 1, { type: { kind: 'concrete', name: 'comfy.MASK' } })]),
  NewNode: schemaOf('NewNode', [
    input('image'),
    widgetInput('strength', 1.0),
    widgetInput('mode', undefined, {
      type: { kind: 'concrete', name: 'COMBO' },
      widget: { widgetType: 'combo', options: {}, default: 'bilinear' },
    }),
    output('image'),
  ]),
  RenamedPorts: schemaOf('RenamedPorts', [
    input('pixels'),
    widgetInput('scale', 2.0),
    output('result'),
  ]),
  SeededNode: schemaOf('SeededNode', [
    widgetInput('seed', 0, { widget: { widgetType: 'number', options: {}, default: 0, controller: 'after_generate' } }),
    output('image'),
  ]),
  NoWidgetTarget: schemaOf('NoWidgetTarget', [input('image'), output('image')]),
  SamePorts: schemaOf('SamePorts', [input('in_image'), output('out_image')]),
  TwoOut: schemaOf('TwoOut', [output('a'), output('b')]),
  ListPrimary: schemaOf('ListPrimary', [input('images'), output('items')]),
  ListJoin: schemaOf('ListJoin', [
    input('a'),
    input('b'),
    widgetInput('count', 1),
    widgetInput('scale', 1, {
      widget: { widgetType: 'number', options: {}, default: 1, controller: 'after_generate' },
    }),
    widgetInput('untouched', 7),
    output('items'),
  ]),
  ListSplit: schemaOf('ListSplit', [input('items'), output('first')]),
  LegacyColon: schemaOf('LegacyColon', [input('in:old'), output('out:old')]),
}
const resolve = (type: string): NodeSchema | undefined => schemas[type]

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

const node = (id: string, type: string, values: Record<string, Json> = {}, extra?: object) => ({
  id: asNodeId(id),
  type,
  values,
  ...extra,
})

const link = (id: string, from: object, to: object) => ({ id: asLinkId(id), from, to }) as GraphDef['links'][string]
const net = (id: string, source: object, sinks: object[]) =>
  ({ id: asNetId(id), name: id, source, sinks }) as GraphDef['nets'][string]

/** OldNode instance wired: producer -> in_image, out_image -> consumer. */
function wiredDoc(): WorkflowDocument {
  return doc({
    g0: graph({
      id: 'g0',
      nodes: {
        src: node('src', 'Producer'),
        old: node('old', 'OldNode', { amount: 0.5 }),
        dst: node('dst', 'Consumer'),
      },
      links: {
        l1: link('l1', port('src', 'out'), port('old', 'in_image')),
        l2: link('l2', port('old', 'out_image'), port('dst', 'in')),
        l3: link('l3', port('old', 'out_image'), port('dst', 'in2')),
      },
    }),
  })
}

const basicRule: ReplacementRule = {
  from: 'OldNode',
  cases: [
    {
      to: 'NewNode',
      inputs: { image: { kind: 'copy', input: 'in_image' }, strength: { kind: 'value', input: 'amount' } },
      outputs: { image: 'out_image' },
    },
  ],
}

// ---------------------------------------------------------------------------
// Rule shape validation
// ---------------------------------------------------------------------------

describe('isReplacementRule', () => {
  it('accepts a rule with an unconditional final case', () => {
    expect(isReplacementRule(basicRule)).toBe(true)
    expect(
      isReplacementRule({
        from: 'A',
        cases: [
          { when: { kind: 'inputConnected', input: 'x' }, to: 'B' },
          { when: { kind: 'always' }, to: 'C' },
        ],
      }),
    ).toBe(true)
  })

  it('rejects a rule whose last case is guarded (missing fallback)', () => {
    expect(
      isReplacementRule({ from: 'A', cases: [{ when: { kind: 'valuePresent', input: 'x' }, to: 'B' }] }),
    ).toBe(false)
  })

  it('rejects malformed predicates, transforms, and mappings', () => {
    expect(isReplacementRule({ from: 'A', cases: [{ when: { kind: 'nope' }, to: 'B' }] })).toBe(false)
    expect(
      isReplacementRule({
        from: 'A',
        cases: [{ to: 'B', inputs: { x: { kind: 'value', input: 'y', transform: { kind: 'wat' } } } }],
      }),
    ).toBe(false)
    expect(isReplacementRule({ from: 'A', cases: [{ to: 'B', inputs: { x: { kind: 'copy' } } }] })).toBe(false)
    expect(isReplacementRule({ from: 'A', cases: [] })).toBe(false)
    expect(isReplacementRule({ from: '', cases: [{ to: 'B' }] })).toBe(false)
  })

  it('accepts family copy and fixed-member mappings and rejects duplicate suffixes', () => {
    expect(isReplacementRule({
      from: 'A',
      cases: [{
        to: 'B',
        inputFamilies: {
          values: {
            kind: 'copy',
            sourceFamily: 'operands',
            inputs: { value: { kind: 'copy', input: 'item' } },
          },
        },
      }],
    })).toBe(true)
    expect(isReplacementRule({
      from: 'A',
      cases: [{
        to: 'B',
        inputFamilies: {
          values: {
            kind: 'members',
            members: [
              { suffix: 'value1', inputs: { value: { kind: 'copy', input: 'a' } } },
              { suffix: 'value2', inputs: { value: { kind: 'constant', value: false } } },
            ],
          },
        },
      }],
    })).toBe(true)
    expect(isReplacementRule({
      from: 'A',
      cases: [{
        to: 'B',
        inputFamilies: {
          values: {
            kind: 'members',
            members: [
              { suffix: 'same', inputs: { value: { kind: 'copy', input: 'a' } } },
              { suffix: 'same', inputs: { value: { kind: 'copy', input: 'b' } } },
            ],
          },
        },
      }],
    })).toBe(false)
  })

  it('accepts output family copy and explicit members with cross-table source injectivity', () => {
    expect(isReplacementRule({
      from: 'A',
      cases: [{
        to: 'B',
        outputs: { static: 'plain' },
        outputFamilies: {
          copied: { kind: 'copy', sourceFamily: 'sourceResults' },
          explicit: {
            kind: 'members',
            members: [{ suffix: '0', output: 'left' }, { suffix: '1', output: 'right' }],
          },
        },
      }],
    })).toBe(true)
    expect(isReplacementRule({
      from: 'A',
      cases: [{
        to: 'B',
        outputs: { static: 'same' },
        outputFamilies: {
          explicit: { kind: 'members', members: [{ suffix: '0', output: 'same' }] },
        },
      }],
    })).toBe(false)
    expect(isReplacementRule({
      from: 'A',
      cases: [{
        to: 'B',
        outputFamilies: {
          first: { kind: 'copy', sourceFamily: 'same' },
          second: { kind: 'copy', sourceFamily: 'same' },
        },
      }],
    })).toBe(false)
  })

  it('rejects malformed or extended output family vocabulary', () => {
    const replacement = (mapping: unknown): unknown => ({
      from: 'A',
      cases: [{ to: 'B', outputFamilies: { results: mapping } }],
    })
    for (const mapping of [
      { kind: 'copy', sourceFamily: 'source', extra: true },
      { kind: 'members', members: [] },
      { kind: 'members', members: [{ suffix: '0', output: 'a' }, { suffix: '0', output: 'b' }] },
      { kind: 'members', members: [{ suffix: '0', output: 'a', extra: true }] },
    ]) expect(isReplacementRule(replacement(mapping))).toBe(false)
  })

  it('strictly decodes Comfy output family vocabulary', () => {
    const valid = {
      from: 'A',
      cases: [{
        to: 'B',
        outputFamilies: {
          copied: { kind: 'copy', sourceFamily: 'source' },
          explicit: { kind: 'members', members: [{ suffix: '0', output: 'left' }] },
        },
      }],
    }
    expect(parseComfyReplacement(valid, 'replacement')).toEqual(valid)
    expect(() => parseComfyReplacement({
      from: 'A',
      cases: [{
        to: 'B',
        outputFamilies: { results: { kind: 'copy', sourceFamily: 'source', extra: true } },
      }],
    }, 'replacement')).toThrow(/unknown fields: extra/)
  })

  it('validates and strictly decodes literal dynamic target choices', () => {
    const valid = {
      from: 'A',
      cases: [{
        to: 'B',
        nodes: { helper: { type: 'H' } },
        slotVariants: { policy: 'tolerance_color', 'policy.color_source': 'integer', 'helper:mode': 'details' },
        inputs: { slot: { kind: 'link', input: 'legacy_slot' } },
      }],
    }
    expect(isReplacementRule(valid)).toBe(true)
    expect(parseComfyReplacement(valid, 'replacement')).toEqual(valid)
    for (const slotVariants of [{}, { policy: '' }, { policy: 7 }, { '.policy': 'choice' }, { 'missing:mode': 'choice' }]) {
      const malformed = { from: 'A', cases: [{ to: 'B', nodes: { helper: { type: 'H' } }, slotVariants }] }
      expect(isReplacementRule(malformed)).toBe(false)
      expect(() => parseComfyReplacement(malformed, 'replacement')).toThrow()
    }
    const stale = { from: 'A', cases: [{ to: 'B', targetChoices: { policy: { kind: 'constant', value: 'exact' } } }] }
    expect(isReplacementRule(stale)).toBe(false)
    expect(() => parseComfyReplacement(stale, 'replacement')).toThrow()
  })

  it('validates and strictly decodes same-type migration markers', () => {
    const valid = {
      from: 'A',
      migration: { historicalInputs: ['legacy.value', 'selector'] },
      cases: [{
        to: 'A',
        when: { kind: 'valueEquals', input: 'selector', value: 'known' },
        inputs: { current: { kind: 'copy', input: 'legacy.value' } },
      }, { to: 'A' }],
    }
    expect(isReplacementRule(valid)).toBe(true)
    expect(parseComfyReplacement(valid, 'replacement')).toEqual(valid)

    const missingFallback = {
      from: 'A',
      migration: { historicalInputs: ['legacy'] },
      cases: [{ to: 'A', when: { kind: 'valuePresent', input: 'legacy' } }],
    }
    expect(isReplacementRule(missingFallback)).toBe(false)
    expect(() => parseComfyReplacement(missingFallback, 'replacement')).toThrow()

    for (const migration of [
      null,
      {},
      { historicalInputs: [] },
      { historicalInputs: [''] },
      { historicalInputs: ['bad..path'] },
      { historicalInputs: [1] },
      { historicalInputs: ['legacy', 'legacy'] },
      { historicalInputs: 'legacy' },
      { historicalInputs: ['legacy'], extra: true },
    ]) {
      const malformed = { from: 'A', migration, cases: [{ to: 'A' }] }
      expect(isReplacementRule(malformed)).toBe(false)
      expect(() => parseComfyReplacement(malformed, 'replacement')).toThrow()
    }

    const changesType = {
      from: 'A',
      migration: { historicalInputs: ['legacy'] },
      cases: [{ to: 'B' }],
    }
    expect(isReplacementRule(changesType)).toBe(false)
    expect(() => parseComfyReplacement(changesType, 'replacement')).toThrow()
  })

  it('rejects cyclic internal links, doubly-fed inputs, and malformed helper addresses', () => {
    expect(
      isReplacementRule({
        from: 'A',
        cases: [{
          to: 'B',
          slotVariants: { mode: { kind: 'copy', input: 'legacy_mode' } },
          inputs: { mode: { kind: 'copy', input: 'legacy_mode' } },
        }],
      }),
    ).toBe(false)
    expect(
      isReplacementRule({
        from: 'A',
        cases: [{
          to: 'B',
          slotVariants: { mask: { kind: 'link', input: 'legacy_mask' } },
          links: [{ from: 'output', to: 'mask' }],
        }],
      }),
    ).toBe(false)
    expect(
      isReplacementRule({
        from: 'A',
        cases: [{
          to: 'B',
          nodes: { helper: { type: 'H' } },
          links: [
            { from: 'out', to: 'helper:in' },
            { from: 'helper:out', to: 'in' },
          ],
        }],
      }),
    ).toBe(false)
    expect(
      isReplacementRule({
        from: 'A',
        cases: [{
          to: 'B',
          nodes: { helper: { type: 'H' } },
          inputs: { 'helper:in': { kind: 'constant', value: 1 } },
          links: [{ from: 'out', to: 'helper:in' }],
        }],
      }),
    ).toBe(false)
    for (const address of ['missing:in', 'helper:in:extra', ':in', 'helper:']) {
      expect(
        isReplacementRule({
          from: 'A',
          cases: [{
            to: 'B',
            nodes: { helper: { type: 'H' } },
            inputs: { [address]: { kind: 'constant', value: 1 } },
          }],
        }),
      ).toBe(false)
    }
  })

  it('rejects helper values that are not owned JSON', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    for (const values of [{ bad: undefined }, { bad: Infinity }, { bad: () => 1 }, cyclic]) {
      expect(
        isReplacementRule({
          from: 'A',
          cases: [{ to: 'B', nodes: { helper: { type: 'H', values } } }],
        }),
      ).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe('createReplacementRegistry', () => {
  it('orders rules schema > pack > core regardless of registration order', () => {
    const reg = createReplacementRegistry()
    const rule = (to: string): ReplacementRule => ({ from: 'OldNode', cases: [{ to }] })
    expect(reg.register('core', rule('CoreTarget'))).toEqual([])
    expect(reg.register('pack', rule('PackTarget'))).toEqual([])
    expect(reg.register('schema', rule('SchemaTarget'))).toEqual([])
    expect(reg.rulesFor('OldNode').map((r) => r.cases[0]!.to)).toEqual(['SchemaTarget', 'PackTarget', 'CoreTarget'])
  })

  it('appends alternatives within a layer in registration order', () => {
    const reg = createReplacementRegistry()
    reg.register('pack', { from: 'OldNode', cases: [{ to: 'First' }] })
    reg.register('pack', { from: 'OldNode', cases: [{ to: 'Second' }] })
    expect(reg.rulesFor('OldNode').map((r) => r.cases[0]!.to)).toEqual(['First', 'Second'])
  })

  it('rejects malformed rules with diagnostics and registers nothing', () => {
    const reg = createReplacementRegistry()
    const out = reg.register('pack', { from: 'X', cases: [{ when: { kind: 'valuePresent', input: 'a' }, to: 'Y' }] })
    expect(out[0]!.code).toBe('replace.rule.invalid')
    expect(reg.rulesFor('X')).toEqual([])
    expect(reg.sourceTypes().size).toBe(0)
  })

  it('sourceTypes unions all layers', () => {
    const reg = createReplacementRegistry()
    reg.register('core', { from: 'A', cases: [{ to: 'X' }] })
    reg.register('pack', { from: 'B', cases: [{ to: 'Y' }] })
    expect([...reg.sourceTypes()].sort()).toEqual(['A', 'B'])
  })
})

// ---------------------------------------------------------------------------
// Guard selection
// ---------------------------------------------------------------------------

describe('planReplacement guards', () => {
  const guardedRule: ReplacementRule = {
    from: 'OldNode',
    cases: [
      { when: { kind: 'inputConnected', input: 'in_image' }, to: 'NoWidgetTarget', inputs: { image: { kind: 'link', input: 'in_image' } } },
      { when: { kind: 'valuePresent', input: 'amount' }, to: 'NewNode', inputs: { strength: { kind: 'value', input: 'amount' } } },
      { to: 'NewNode' },
    ],
  }

  it('selects the connected case when a link feeds the input', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { src: node('src', 'P'), old: node('old', 'OldNode') },
        links: { l1: link('l1', port('src', 'out'), port('old', 'in_image')) },
      }),
    })
    const out = planReplacement(d, 'g0', 'old', guardedRule, resolve)
    expect(out.plan?.to).toBe('NoWidgetTarget')
    expect(out.plan?.caseIndex).toBe(0)
  })

  it('a named-net sink counts as connected', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { src: node('src', 'P'), old: node('old', 'OldNode') },
        nets: { net1: net('net1', port('src', 'out'), [port('old', 'in_image')]) },
      }),
    })
    const out = planReplacement(d, 'g0', 'old', guardedRule, resolve)
    expect(out.plan?.caseIndex).toBe(0)
  })

  it('falls through to valuePresent, then to the fallback', () => {
    const withValue = doc({ g0: graph({ id: 'g0', nodes: { old: node('old', 'OldNode', { amount: 2 }) } }) })
    expect(planReplacement(withValue, 'g0', 'old', guardedRule, resolve).plan?.caseIndex).toBe(1)
    const bare = doc({ g0: graph({ id: 'g0', nodes: { old: node('old', 'OldNode') } }) })
    expect(planReplacement(bare, 'g0', 'old', guardedRule, resolve).plan?.caseIndex).toBe(2)
  })

  it('valueEquals, not, all, any compose over document state', () => {
    const rule: ReplacementRule = {
      from: 'OldNode',
      cases: [
        {
          when: {
            kind: 'all',
            of: [
              { kind: 'valueEquals', input: 'mode', value: 'legacy' },
              { kind: 'not', of: { kind: 'inputConnected', input: 'in_image' } },
              { kind: 'any', of: [{ kind: 'valuePresent', input: 'amount' }, { kind: 'always' }] },
            ],
          },
          to: 'NewNode',
        },
        { to: 'NoWidgetTarget' },
      ],
    }
    const d = doc({ g0: graph({ id: 'g0', nodes: { old: node('old', 'OldNode', { mode: 'legacy' }) } }) })
    expect(planReplacement(d, 'g0', 'old', rule, resolve).plan?.caseIndex).toBe(0)
    const d2 = doc({ g0: graph({ id: 'g0', nodes: { old: node('old', 'OldNode', { mode: 'new' }) } }) })
    expect(planReplacement(d2, 'g0', 'old', rule, resolve).plan?.caseIndex).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Value mapping
// ---------------------------------------------------------------------------

describe('planReplacement values', () => {
  it('copies values by semantic id, fills unmapped defaults explicitly', () => {
    const out = planReplacement(wiredDoc(), 'g0', 'old', basicRule, resolve)
    expect(out.plan).toBeDefined()
    // strength mapped from amount; mode unmapped -> explicit schema default
    expect(out.plan!.values).toEqual({ strength: 0.5, mode: 'bilinear' })
  })

  it('constants and enum renames apply; missing enum mapping is fatal', () => {
    const rule: ReplacementRule = {
      from: 'OldNode',
      cases: [
        {
          to: 'NewNode',
          inputs: {
            strength: { kind: 'constant', value: 3 },
            mode: { kind: 'value', input: 'mode', transform: { kind: 'enumRename', map: { nearest: 'nearest-exact' } } },
          },
        },
      ],
    }
    const ok = doc({ g0: graph({ id: 'g0', nodes: { old: node('old', 'OldNode', { mode: 'nearest' }) } }) })
    const out = planReplacement(ok, 'g0', 'old', rule, resolve)
    expect(out.plan!.values).toMatchObject({ strength: 3, mode: 'nearest-exact' })

    const bad = doc({ g0: graph({ id: 'g0', nodes: { old: node('old', 'OldNode', { mode: 'mystery' }) } }) })
    const failed = planReplacement(bad, 'g0', 'old', rule, resolve)
    expect(failed.plan).toBeUndefined()
    expect(failed.diagnostics.some((d) => d.code === 'replace.transform.enum')).toBe(true)
  })

  it('scale transforms numbers and rejects non-numbers', () => {
    const rule: ReplacementRule = {
      from: 'OldNode',
      cases: [{ to: 'NewNode', inputs: { strength: { kind: 'value', input: 'amount', transform: { kind: 'scale', factor: 100, offset: 1 } } } }],
    }
    const d = doc({ g0: graph({ id: 'g0', nodes: { old: node('old', 'OldNode', { amount: 0.25 }) } }) })
    expect(planReplacement(d, 'g0', 'old', rule, resolve).plan!.values.strength).toBe(26)

    const bad = doc({ g0: graph({ id: 'g0', nodes: { old: node('old', 'OldNode', { amount: 'high' }) } }) })
    const failed = planReplacement(bad, 'g0', 'old', rule, resolve)
    expect(failed.plan).toBeUndefined()
    expect(failed.diagnostics.some((d) => d.code === 'replace.transform.scale')).toBe(true)
  })

  it('carries controller modes to the mapped target input', () => {
    const rule: ReplacementRule = {
      from: 'OldSeeded',
      cases: [{ to: 'SeededNode', inputs: { seed: { kind: 'value', input: 'noise_seed' } } }],
    }
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { old: node('old', 'OldSeeded', { noise_seed: 42 }, { controllers: { noise_seed: 'randomize' } }) },
      }),
    })
    const out = planReplacement(d, 'g0', 'old', rule, resolve)
    expect(out.plan!.values.seed).toBe(42)
    expect(out.plan!.controllers).toEqual({ seed: 'randomize' })
  })

  it('rejects value writes to a target input with no widget (except copy, which warns)', () => {
    const constantRule: ReplacementRule = {
      from: 'OldNode',
      cases: [{ to: 'NoWidgetTarget', inputs: { image: { kind: 'constant', value: 1 } } }],
    }
    const d = doc({ g0: graph({ id: 'g0', nodes: { old: node('old', 'OldNode') } }) })
    const failed = planReplacement(d, 'g0', 'old', constantRule, resolve)
    expect(failed.plan).toBeUndefined()
    expect(failed.diagnostics.some((x) => x.code === 'replace.target.notWidget')).toBe(true)

    const copyRule: ReplacementRule = {
      from: 'OldNode',
      cases: [{ to: 'NoWidgetTarget', inputs: { image: { kind: 'copy', input: 'in_image' } } }],
    }
    const d2 = doc({ g0: graph({ id: 'g0', nodes: { old: node('old', 'OldNode', { in_image: 'stored' }) } }) })
    const out = planReplacement(d2, 'g0', 'old', copyRule, resolve)
    expect(out.plan).toBeDefined()
    expect(out.diagnostics.some((x) => x.code === 'replace.value.dropped' && x.severity === 'warning')).toBe(true)
  })

  it('rejects unknown target inputs/outputs and dynamic member paths', () => {
    const d = doc({ g0: graph({ id: 'g0', nodes: { old: node('old', 'OldNode') } }) })
    const badInput: ReplacementRule = { from: 'OldNode', cases: [{ to: 'NewNode', inputs: { nope: { kind: 'constant', value: 1 } } }] }
    expect(planReplacement(d, 'g0', 'old', badInput, resolve).diagnostics.some((x) => x.code === 'replace.target.inputMissing')).toBe(true)
    const badOutput: ReplacementRule = { from: 'OldNode', cases: [{ to: 'NewNode', outputs: { nope: 'out_image' } }] }
    expect(planReplacement(d, 'g0', 'old', badOutput, resolve).diagnostics.some((x) => x.code === 'replace.target.outputMissing')).toBe(true)
    const badPath: ReplacementRule = { from: 'OldNode', cases: [{ to: 'NewNode', inputs: { 'items.slot': { kind: 'constant', value: 1 } } }] }
    expect(planReplacement(d, 'g0', 'old', badPath, resolve).diagnostics.some((x) => x.code === 'replace.target.dynamicPath')).toBe(true)
  })

  it('rejects subgraph targets and unknown target types', () => {
    const d = doc({ g0: graph({ id: 'g0', nodes: { old: node('old', 'OldNode') } }) })
    const sub: ReplacementRule = { from: 'OldNode', cases: [{ to: '#g1' }] }
    expect(planReplacement(d, 'g0', 'old', sub, resolve).diagnostics[0]!.code).toBe('replace.target.subgraph')
    const unknown: ReplacementRule = { from: 'OldNode', cases: [{ to: 'Nonexistent' }] }
    expect(planReplacement(d, 'g0', 'old', unknown, resolve).diagnostics[0]!.code).toBe('replace.target.unknown')
  })
})

// ---------------------------------------------------------------------------
// Graph rewires
// ---------------------------------------------------------------------------

describe('planReplacement rewires', () => {
  const tapRule = (to: string): ReplacementRule => ({ from: 'TapOld', cases: [{ to }] })
  const tapDoc = (): WorkflowDocument => doc({
    g0: graph({
      id: 'g0',
      nodes: {
        old: node('old', 'TapOld', { amount: 0.25 }),
        dst: node('dst', 'Consumer'),
      },
      links: {
        tapLink: link('tapLink', { node: asNodeId('old'), tap: asPortId('amount') }, port('dst', 'in')),
      },
    }),
  })

  it('preserves a compatible static widget tap through one-step undo and redo', () => {
    const before = tapDoc()
    const planned = planReplacement(before, 'g0', 'old', tapRule('TapSame'), resolve)
    expect(planned.diagnostics).toEqual([])
    expect(planned.plan!.tapGuards).toEqual([{ link: 'tapLink', tap: 'amount' }])
    expect(planned.plan!.dropLinks).toEqual([])

    const store = new DocumentStore(before, coreCommandRegistry())
    expect(store.dispatch({ command: 'node.replace', params: { plan: planned.plan! } as unknown as Record<string, Json> }).ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes.old!.type).toBe('TapSame')
    expect(store.doc.graphs.g0!.links.tapLink).toEqual(before.graphs.g0!.links.tapLink)
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(before)
    expect(store.redo()).toBe(true)
    expect(store.doc.graphs.g0!.links.tapLink).toEqual(before.graphs.g0!.links.tapLink)
  })

  it.each([
    ['missing', 'NewNode'],
    ['incompatible type', 'TapWrongType'],
    ['forced socket', 'TapForced'],
    ['dynamic declaration', 'TapDynamic'],
    ['ambiguous elaboration', 'TapAmbiguous'],
  ])('routes an unsupported %s tap through dropped-link review', (_reason, to) => {
    const planned = planReplacement(tapDoc(), 'g0', 'old', tapRule(to), resolve)
    expect(planned.plan!.dropLinks).toEqual(['tapLink'])
    expect(planned.plan!.tapGuards).toEqual([{ link: 'tapLink', tap: 'amount' }])
    expect(planned.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'warning',
      code: 'replace.output.dropped',
    }))
  })

  it('compares declared tap types independent of object key order', () => {
    const planned = planReplacement(tapDoc(), 'g0', 'old', tapRule('TapSameReordered'), resolve)
    expect(planned.diagnostics).toEqual([])
    expect(planned.plan!.dropLinks).toEqual([])
  })

  it('treats interchangeable comfy-compat tap type spellings as the same type', () => {
    const before = doc({
      g0: graph({
        id: 'g0',
        nodes: {
          old: node('old', 'TapMaskOld', { amount: 0.25 }),
          dst: node('dst', 'Consumer'),
        },
        links: {
          tapLink: link('tapLink', { node: asNodeId('old'), tap: asPortId('amount') }, port('dst', 'in')),
        },
      }),
    })
    const rule: ReplacementRule = { from: 'TapMaskOld', cases: [{ to: 'TapMaskComfy' }] }
    const planned = planReplacement(before, 'g0', 'old', rule, resolve)
    expect(planned.diagnostics).toEqual([])
    expect(planned.plan!.dropLinks).toEqual([])
    expect(planned.plan!.tapGuards).toEqual([{ link: 'tapLink', tap: 'amount' }])
  })

  it('refuses stale or ambiguous tap identity without changing the port target', () => {
    const before = tapDoc()
    const planned = planReplacement(before, 'g0', 'old', tapRule('TapSame'), resolve).plan!
    const stale = {
      ...before,
      graphs: {
        ...before.graphs,
        g0: {
          ...before.graphs.g0!,
          links: {
            tapLink: link('tapLink', { node: asNodeId('old'), tap: asPortId('other') }, port('dst', 'in')),
          },
        },
      },
    }
    const store = new DocumentStore(stale, coreCommandRegistry())
    const result = store.dispatch({ command: 'node.replace', params: { plan: planned } as unknown as Record<string, Json> })
    expect(result.ok).toBe(false)
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'replace.stale' }))
    expect(store.doc).toEqual(stale)
    expect(store.doc.graphs.g0!.links.tapLink!.to).toEqual(port('dst', 'in'))
  })

  it.each([
    { node: asNodeId('old'), tap: asPortId('amount'), members: [asDynamicMemberId('m0')] },
    { node: asNodeId('old'), tap: asPortId('amount'), port: asPortId('amount') },
  ])('refuses a tap source that gains extra identity fields before apply', (from) => {
    const before = tapDoc()
    const planned = planReplacement(before, 'g0', 'old', tapRule('TapSame'), resolve).plan!
    const stale = {
      ...before,
      graphs: {
        ...before.graphs,
        g0: {
          ...before.graphs.g0!,
          links: { tapLink: link('tapLink', from, port('dst', 'in')) },
        },
      },
    }
    const store = new DocumentStore(stale, coreCommandRegistry())
    const result = store.dispatch({ command: 'node.replace', params: { plan: planned } as unknown as Record<string, Json> })
    expect(result.ok).toBe(false)
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'replace.stale' }))
    expect(store.doc).toEqual(stale)
  })

  it('refuses malformed tap sources during planning', () => {
    const malformed = tapDoc()
    const g = malformed.graphs.g0!
    const withMember = {
      ...malformed,
      graphs: {
        ...malformed.graphs,
        g0: {
          ...g,
          links: {
            tapLink: link('tapLink', {
              node: asNodeId('old'), tap: asPortId('amount'), members: [asDynamicMemberId('m0')],
            }, port('dst', 'in')),
          },
        },
      },
    }
    const planned = planReplacement(withMember, 'g0', 'old', tapRule('TapSame'), resolve)
    expect(planned.plan).toBeUndefined()
    expect(planned.diagnostics).toContainEqual(expect.objectContaining({ code: 'replace.tap.invalid' }))
  })

  it('moves incoming links and preserves outgoing fan-out', () => {
    const out = planReplacement(wiredDoc(), 'g0', 'old', basicRule, resolve)
    const plan = out.plan!
    expect(plan.inputRewires).toEqual([{ link: 'l1', port: 'image' }])
    // out_image -> image on both downstream links
    expect(plan.outputRewires).toEqual([
      { link: 'l2', port: 'image' },
      { link: 'l3', port: 'image' },
    ])
    expect(plan.dropLinks).toEqual([])
    expect(out.diagnostics).toEqual([])
  })

  it('emits no rewire when source and target port ids match', () => {
    const rule: ReplacementRule = {
      from: 'OldNode',
      cases: [{ to: 'NewNode', inputs: { image: { kind: 'copy', input: 'image' } }, outputs: { image: 'image' } }],
    }
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { src: node('src', 'P'), old: node('old', 'OldNode'), dst: node('dst', 'C') },
        links: {
          l1: link('l1', port('src', 'out'), port('old', 'image')),
          l2: link('l2', port('old', 'image'), port('dst', 'in')),
        },
      }),
    })
    const out = planReplacement(d, 'g0', 'old', rule, resolve)
    expect(out.plan!.inputRewires).toEqual([])
    expect(out.plan!.outputRewires).toEqual([])
    expect(out.plan!.dropLinks).toEqual([])
    expect(out.diagnostics).toEqual([])
  })

  it('two mappings consuming one source connection is fatal', () => {
    const rule: ReplacementRule = {
      from: 'OldNode',
      cases: [
        {
          to: 'NewNode',
          inputs: { image: { kind: 'link', input: 'in_image' }, strength: { kind: 'link', input: 'in_image' } },
        },
      ],
    }
    const out = planReplacement(wiredDoc(), 'g0', 'old', rule, resolve)
    expect(out.plan).toBeUndefined()
    expect(out.diagnostics.some((d) => d.code === 'replace.link.doubleConsume')).toBe(true)
  })

  it('one source output mapped to two target outputs is fatal', () => {
    const rule: ReplacementRule = {
      from: 'OldNode',
      cases: [{ to: 'TwoOut', outputs: { a: 'out_image', b: 'out_image' } }],
    }
    const out = planReplacement(wiredDoc(), 'g0', 'old', rule, resolve)
    expect(out.plan).toBeUndefined()
    expect(out.diagnostics.some((d) => d.code === 'replace.output.doubleConsume')).toBe(true)
  })

  it('unmapped connections drop explicitly with warnings (review-required)', () => {
    const rule: ReplacementRule = { from: 'OldNode', cases: [{ to: 'NewNode' }] }
    const out = planReplacement(wiredDoc(), 'g0', 'old', rule, resolve)
    const plan = out.plan!
    expect([...plan.dropLinks].sort()).toEqual(['l1', 'l2', 'l3'])
    expect(out.diagnostics.some((d) => d.code === 'replace.link.dropped')).toBe(true)
    expect(out.diagnostics.some((d) => d.code === 'replace.output.dropped')).toBe(true)
    expect(out.diagnostics.every((d) => d.severity === 'warning')).toBe(true)
  })

  it('rewrites named-net sinks and sources by port id', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { src: node('src', 'P'), old: node('old', 'OldNode'), dst: node('dst', 'C') },
        nets: {
          netIn: net('netIn', port('src', 'out'), [port('old', 'in_image'), port('dst', 'other')]),
          netOut: net('netOut', port('old', 'out_image'), [port('dst', 'in')]),
        },
      }),
    })
    const out = planReplacement(d, 'g0', 'old', basicRule, resolve)
    const plan = out.plan!
    expect(plan.netSinks).toEqual([
      { net: 'netIn', sinks: [port('old', 'image'), port('dst', 'other')] },
    ])
    expect(plan.netSourceRewires).toEqual([{ net: 'netOut', port: 'image' }])
    expect(plan.dropNets).toEqual([])
    expect(out.diagnostics).toEqual([])
  })

  it('drops unmapped net connections explicitly', () => {
    const rule: ReplacementRule = { from: 'OldNode', cases: [{ to: 'NewNode' }] }
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { src: node('src', 'P'), old: node('old', 'OldNode'), dst: node('dst', 'C') },
        nets: {
          netIn: net('netIn', port('src', 'out'), [port('old', 'in_image'), port('dst', 'other')]),
          netOut: net('netOut', port('old', 'out_image'), [port('dst', 'in')]),
        },
      }),
    })
    const out = planReplacement(d, 'g0', 'old', rule, resolve)
    const plan = out.plan!
    expect(plan.dropNets).toEqual(['netOut'])
    // netIn keeps only the sink on the other node
    expect(plan.netSinks).toEqual([{ net: 'netIn', sinks: [port('dst', 'other')] }])
    expect(out.diagnostics.some((d) => d.code === 'replace.net.sinkDropped')).toBe(true)
    expect(out.diagnostics.some((d) => d.code === 'replace.net.dropped')).toBe(true)
  })

  it('reroute/selector/value-source feeds rewire by endpoint, untouched upstream', () => {
    // A link whose `from` is not a port endpoint (reroute ref) still rewires
    // its `to` side - the plan addresses link endpoints, not producers.
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { src: node('src', 'P'), old: node('old', 'OldNode') },
        reroutes: { r1: { id: 'r1' } as GraphDef['reroutes'][string] },
        links: {
          feed: link('feed', port('src', 'out'), { reroute: 'r1' }),
          l1: link('l1', { reroute: 'r1' }, port('old', 'in_image')),
        },
      }),
    })
    const out = planReplacement(d, 'g0', 'old', basicRule, resolve)
    expect(out.plan!.inputRewires).toEqual([{ link: 'l1', port: 'image' }])
    expect(out.plan!.dropLinks).toEqual([])
  })

  it('dynamic member connections are invisible to rules and dropped with warnings', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { src: node('src', 'P'), old: node('old', 'OldNode'), dst: node('dst', 'C') },
        links: {
          l1: link('l1', port('src', 'out'), mport('old', 'items', 'm1')),
          l2: link('l2', port('src', 'out'), port('old', 'in_image')),
        },
        nets: {
          netM: net('netM', port('src', 'out'), [mport('old', 'items', 'm2'), port('dst', 'other')]),
        },
      }),
    })
    const out = planReplacement(d, 'g0', 'old', basicRule, resolve)
    const plan = out.plan!
    expect(plan.inputRewires).toEqual([{ link: 'l2', port: 'image' }])
    expect(plan.dropLinks).toEqual(['l1'])
    expect(plan.netSinks).toEqual([{ net: 'netM', sinks: [port('dst', 'other')] }])
    expect(out.diagnostics.some((d) => d.code === 'replace.dynamic.dropped')).toBe(true)
  })

  it('boundary bindings follow input and output mappings as rewires', () => {
    const d = doc(
      {
        g0: graph({
          id: 'g0',
          nodes: { inst: node('inst', '#g1') },
        }),
        g1: graph({
          id: 'g1',
          nodes: { old: node('old', 'OldNode') },
          boundary: {
            inputs: [{ id: 'bi', binds: { kind: 'port' as const, ...port('old', 'in_image') } }],
            outputs: [{ id: 'bo', binds: { kind: 'port' as const, ...port('old', 'out_image') } }],
          },
        }),
      },
      'g0',
    )
    const out = planReplacement(d, 'g1', 'old', basicRule, resolve)
    expect(out.diagnostics.filter((x) => x.severity === 'error')).toEqual([])
    expect(out.plan!.boundaryRewires).toEqual([
      { item: 'bi', side: 'input', fromPort: 'in_image', port: 'image' },
      { item: 'bo', side: 'output', fromPort: 'out_image', port: 'image' },
    ])
  })

  it('fan-out bindings (alsoBinds) are migrated with their index', () => {
    const d = doc(
      {
        g0: graph({
          id: 'g0',
          nodes: { inst: node('inst', '#g1') },
        }),
        g1: graph({
          id: 'g1',
          nodes: { keep: node('keep', 'Other'), old: node('old', 'OldNode') },
          boundary: {
            inputs: [{
              id: 'bi',
              binds: { kind: 'port' as const, ...port('keep', 'in_image') },
              alsoBinds: [{ kind: 'port' as const, ...port('old', 'in_image') }],
            }],
            outputs: [],
          },
        }),
      },
      'g0',
    )
    const out = planReplacement(d, 'g1', 'old', basicRule, resolve)
    expect(out.diagnostics.filter((x) => x.severity === 'error')).toEqual([])
    expect(out.plan!.boundaryRewires).toEqual([{ item: 'bi', side: 'input', fromPort: 'in_image', port: 'image', alsoIndex: 0 }])
  })

  it('same-port mappings leave bindings alone (no rewire entry)', () => {
    const d = doc(
      {
        g0: graph({
          id: 'g0',
          nodes: { inst: node('inst', '#g1') },
        }),
        g1: graph({
          id: 'g1',
          nodes: { old: node('old', 'OldNode') },
          boundary: {
            inputs: [{ id: 'bi', binds: { kind: 'port' as const, ...port('old', 'in_image') } }],
            outputs: [{ id: 'bo', binds: { kind: 'port' as const, ...port('old', 'out_image') } }],
          },
        }),
      },
      'g0',
    )
    const samePortRule: ReplacementRule = {
      from: 'OldNode',
      cases: [
        {
          to: 'SamePorts',
          inputs: { in_image: { kind: 'copy', input: 'in_image' } },
          outputs: { out_image: 'out_image' },
        },
      ],
    }
    const out = planReplacement(d, 'g1', 'old', samePortRule, resolve)
    expect(out.diagnostics.filter((x) => x.severity === 'error')).toEqual([])
    expect(out.plan!.boundaryRewires).toBeUndefined()
  })

  it('a bound port the rule does not map is a hard error, not a silent drop', () => {
    const d = doc(
      {
        g0: graph({
          id: 'g0',
          nodes: { inst: node('inst', '#g1') },
        }),
        g1: graph({
          id: 'g1',
          nodes: { old: node('old', 'OldNode') },
          boundary: {
            inputs: [{ id: 'bi', binds: { kind: 'port' as const, ...port('old', 'in_mask') } }],
            outputs: [],
          },
        }),
      },
      'g0',
    )
    const out = planReplacement(d, 'g1', 'old', basicRule, resolve)
    expect(out.plan).toBeUndefined()
    expect(out.diagnostics.some((x) => x.code === 'replace.boundary.unmapped')).toBe(true)
  })

  it('family bindings cannot migrate (dynamic state is dropped)', () => {
    const d = doc(
      {
        g0: graph({
          id: 'g0',
          nodes: { inst: node('inst', '#g1') },
        }),
        g1: graph({
          id: 'g1',
          nodes: { old: node('old', 'OldNode') },
          boundary: {
            inputs: [{ id: 'bi', binds: { kind: 'family' as const, ...port('old', 'items') } }],
            outputs: [],
          },
        }),
      },
      'g0',
    )
    const out = planReplacement(d, 'g1', 'old', basicRule, resolve)
    expect(out.plan).toBeUndefined()
    expect(out.diagnostics.some((x) => x.code === 'replace.boundary.dynamic')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Dynamic input-family mappings
// ---------------------------------------------------------------------------

describe('input family replacement', () => {
  const familyInput = (id: string, names: readonly string[]): InputSpec => ({
    kind: 'input',
    id,
    type: { kind: 'wildcard' },
    optional: true,
    dynamic: {
      kind: 'autogrow',
      materialization: 'wire15',
      template: [widgetInput('value', 0, {
        widget: { widgetType: 'number', options: {}, default: 0, controller: 'after_generate' },
      })],
      naming: { kind: 'names', names, min: 1 },
    },
  })
  const familySchemas: Record<string, NodeSchema> = {
    FamilyOld: schemaOf('FamilyOld', [familyInput('operands', ['a', 'b'])]),
    FamilyNew: schemaOf('FamilyNew', [familyInput('values', ['a', 'b'])]),
    HelperFamily: schemaOf('HelperFamily', [familyInput('values', ['a', 'b'])]),
    PlainNew: schemaOf('PlainNew', []),
    ResizeTarget: schemaOf('ResizeTarget', [input('megapixels')]),
    PixelExpression: schemaOf('PixelExpression', [
      familyInput('values', ['a', 'b']),
      output('float'),
    ]),
    IntegerValue: schemaOf('IntegerValue', [widgetInput('value', 0), output('value')]),
    StaticOld: schemaOf('StaticOld', [widgetInput('a', false), widgetInput('b', false)]),
    PixelOld: schemaOf('PixelOld', [widgetInput('width', 512), widgetInput('height', 512)]),
    LogicNew: schemaOf('LogicNew', [
      widgetInput('operation', undefined, {
        type: { kind: 'concrete', name: 'STRING' },
        widget: { widgetType: 'STRING', options: {}, default: 'or' },
      }),
      {
        ...familyInput('values', []),
        dynamic: {
          kind: 'autogrow',
          materialization: 'wire15',
          template: [widgetInput('value', false)],
          naming: { kind: 'prefix', prefix: 'value', min: 1, max: 8 },
        },
      },
    ]),
  }
  const familyResolve = (type: string): NodeSchema | undefined => familySchemas[type]

  it('copies a differently named family with suffixes, order, values, controllers, links, and net sinks', () => {
    const original = doc({
      g0: graph({
        id: 'g0',
        nodes: {
          src: node('src', 'Producer'),
          old: node('old', 'FamilyOld', {
            'operands.b': 2,
            'operands.a': 1,
          }, {
            controllers: { 'operands.b': 'increment' },
            dynamic: { operands: { members: ['b', 'a'] } },
          }),
          dst: node('dst', 'Consumer'),
        },
        links: {
          linked: link('linked', port('src', 'out'), port('old', 'operands.b')),
        },
        nets: {
          routed: net('routed', port('src', 'out'), [port('old', 'operands.a'), port('dst', 'other')]),
        },
      }),
    })
    const rule: ReplacementRule = {
      from: 'FamilyOld',
      cases: [{
        to: 'FamilyNew',
        inputFamilies: {
          values: {
            kind: 'copy',
            sourceFamily: 'operands',
            inputs: { value: { kind: 'copy', input: 'value' } },
          },
        },
      }],
    }
    expect(isReplacementRule(rule)).toBe(true)
    expect(parseComfyReplacement(rule, 'replacement')).toEqual(rule)
    const planned = planReplacement(original, 'g0', 'old', rule, familyResolve)
    expect(planned.diagnostics).toEqual([])
    expect(planned.plan?.dynamic).toEqual({ values: { members: ['b', 'a'] } })
    expect(planned.plan?.values).toEqual({ 'values.b': 2, 'values.a': 1 })
    expect(planned.plan?.controllers).toEqual({ 'values.b': 'increment' })
    expect(planned.plan?.inputRewires).toEqual([{ link: 'linked', port: 'values.b' }])
    expect(planned.plan?.netSinks).toEqual([
      { net: 'routed', sinks: [port('old', 'values.a'), port('dst', 'other')] },
    ])

    const store = new DocumentStore(original, coreCommandRegistry())
    expect(store.dispatch({ command: 'node.replace', params: { plan: planned.plan! } as unknown as Json }).ok)
      .toBe(true)
    expect(store.doc.graphs.g0!.nodes.old).toMatchObject({
      type: 'FamilyNew',
      dynamic: { values: { members: ['b', 'a'] } },
      values: { 'values.b': 2, 'values.a': 1 },
    })
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(original)
  })

  it('maps fixed source inputs to explicit ordered target members', () => {
    const original = doc({
      g0: graph({
        id: 'g0',
        nodes: {
          src: node('src', 'Producer'),
          old: node('old', 'StaticOld', { a: true, b: false }),
        },
        links: { linked: link('linked', port('src', 'out'), port('old', 'b')) },
      }),
    })
    const rule: ReplacementRule = {
      from: 'StaticOld',
      cases: [{
        to: 'LogicNew',
        inputs: { operation: { kind: 'constant', value: 'and' } },
        inputFamilies: {
          values: {
            kind: 'members',
            members: [
              { suffix: 'value1', inputs: { value: { kind: 'copy', input: 'a' } } },
              { suffix: 'value2', inputs: { value: { kind: 'copy', input: 'b' } } },
            ],
          },
        },
      }],
    }
    expect(isReplacementRule(rule)).toBe(true)
    expect(parseComfyReplacement(rule, 'replacement')).toEqual(rule)
    const planned = planReplacement(original, 'g0', 'old', rule, familyResolve)
    expect(planned.diagnostics).toEqual([])
    expect(planned.plan?.dynamic).toEqual({ values: { members: ['value1', 'value2'] } })
    expect(planned.plan?.values).toEqual({
      operation: 'and',
      'values.value1': true,
      'values.value2': false,
    })
    expect(planned.plan?.inputRewires).toEqual([{ link: 'linked', port: 'values.value2' }])
  })

  it('maps fixed source inputs into a helper input family', () => {
    const original = doc({
      g0: graph({
        id: 'g0',
        nodes: {
          src: node('src', 'Producer'),
          old: node('old', 'StaticOld', { a: true, b: false }),
        },
        links: { linked: link('linked', port('src', 'out'), port('old', 'b')) },
      }),
    })
    const rule: ReplacementRule = {
      from: 'StaticOld',
      cases: [{
        to: 'PlainNew',
        nodes: { calculate: { type: 'HelperFamily' } },
        inputFamilies: {
          'calculate:values': {
            kind: 'members',
            members: [
              { suffix: 'a', inputs: { value: { kind: 'copy', input: 'a' } } },
              { suffix: 'b', inputs: { value: { kind: 'copy', input: 'b' } } },
            ],
          },
        },
      }],
    }
    expect(isReplacementRule(rule)).toBe(true)
    expect(parseComfyReplacement(rule, 'replacement')).toEqual(rule)
    const planned = planReplacement(original, 'g0', 'old', rule, familyResolve)
    expect(planned.diagnostics).toEqual([])
    expect(planned.plan?.createdNodes).toEqual([expect.objectContaining({
      localId: 'calculate',
      dynamic: { values: { members: ['a', 'b'] } },
      values: { 'values.a': true, 'values.b': false },
    })])
    expect(planned.plan?.inputRewires).toEqual([{
      link: 'linked',
      node: 'old:calculate',
      port: 'values.b',
    }])
  })

  it('combines linked and literal dimensions through a helper input family', () => {
    const original = doc({
      g0: graph({
        id: 'g0',
        nodes: {
          src: node('src', 'Producer'),
          old: node('old', 'PixelOld', { width: 640, height: 768 }),
        },
        links: { linked: link('linked', port('src', 'out'), port('old', 'width')) },
      }),
    })
    const rule: ReplacementRule = {
      from: 'PixelOld',
      cases: [{
        to: 'ResizeTarget',
        nodes: {
          pixels: { type: 'PixelExpression' },
          height: { type: 'IntegerValue' },
        },
        inputs: {
          'height:value': { kind: 'value', input: 'height' },
        },
        inputFamilies: {
          'pixels:values': {
            kind: 'members',
            members: [
              { suffix: 'a', inputs: { value: { kind: 'link', input: 'width' } } },
              { suffix: 'b', inputs: { value: { kind: 'link', input: 'height' } } },
            ],
          },
        },
        links: [
          { from: 'height:value', to: 'pixels:values.b' },
          { from: 'pixels:float', to: 'megapixels' },
        ],
      }],
    }

    expect(isReplacementRule(rule)).toBe(true)
    expect(parseComfyReplacement(rule, 'replacement')).toEqual(rule)
    const planned = planReplacement(original, 'g0', 'old', rule, familyResolve)
    expect(planned.diagnostics).toEqual([])
    expect(planned.plan?.createdNodes).toEqual([
      expect.objectContaining({
        localId: 'pixels',
        dynamic: { values: { members: ['a', 'b'] } },
      }),
      expect.objectContaining({ localId: 'height', values: { value: 768 } }),
    ])
    expect(planned.plan?.inputRewires).toEqual([{
      link: 'linked',
      node: 'old:pixels',
      port: 'values.a',
    }])
    expect(planned.plan?.links).toEqual([
      { from: port('old:height', 'value'), to: port('old:pixels', 'values.b') },
      { from: port('old:pixels', 'float'), to: port('old', 'megapixels') },
    ])
  })

  it('refuses copied members outside the target vocabulary', () => {
    const original = doc({
      g0: graph({
        id: 'g0',
        nodes: {
          old: node('old', 'FamilyOld', {}, { dynamic: { operands: { members: ['b', 'a'] } } }),
        },
      }),
    })
    const restricted = schemaOf('Restricted', [familyInput('values', ['a'])])
    const rule: ReplacementRule = {
      from: 'FamilyOld',
      cases: [{
        to: 'Restricted',
        inputFamilies: {
          values: {
            kind: 'copy',
            sourceFamily: 'operands',
            inputs: { value: { kind: 'copy', input: 'value' } },
          },
        },
      }],
    }
    const planned = planReplacement(
      original,
      'g0',
      'old',
      rule,
      (type) => type === restricted.type ? restricted : familyResolve(type),
    )
    expect(planned.plan).toBeUndefined()
    expect(planned.diagnostics.some((diagnostic) => diagnostic.code === 'replace.target.familyMembers'))
      .toBe(true)
  })

  it('refuses copied member suffixes that cannot form wire-15 paths', () => {
    const original = doc({
      g0: graph({
        id: 'g0',
        nodes: {
          old: node('old', 'FamilyOld', {}, {
            dynamic: { operands: { members: ['bad.member'] } },
          }),
        },
      }),
    })
    const rule: ReplacementRule = {
      from: 'FamilyOld',
      cases: [{
        to: 'LogicNew',
        inputFamilies: {
          values: {
            kind: 'copy',
            sourceFamily: 'operands',
            inputs: { value: { kind: 'copy', input: 'value' } },
          },
        },
      }],
    }
    const planned = planReplacement(original, 'g0', 'old', rule, familyResolve)
    expect(planned.plan).toBeUndefined()
    expect(planned.diagnostics.some((diagnostic) => diagnostic.code === 'replace.target.familyMembers'))
      .toBe(true)
  })
})

describe('output family replacement', () => {
  const countInput = (id: string): InputSpec => input(id, {
    type: { kind: 'concrete', name: 'core.int' },
  })
  const outputFamily = (id: string, count: string, max = 512): OutputSpec => ({
    kind: 'output',
    id,
    type: IMAGE,
    dynamic: {
      kind: 'autogrow',
      materialization: 'wire15',
      template: [input('value')],
      naming: { kind: 'prefix', prefix: 'value', min: 0, max },
      count: { input: count, suffix: 'index' },
    },
  })
  const outputSchemas: Record<string, NodeSchema> = {
    FamilyOutputOld: schemaOf('FamilyOutputOld', [countInput('count'), outputFamily('results', 'count')]),
    FamilyOutputNew: schemaOf('FamilyOutputNew', [countInput('quantity'), outputFamily('items', 'quantity')]),
    CountSource: schemaOf('CountSource', [countInput('count')]),
    StaticOutputOld: schemaOf('StaticOutputOld', [output('left'), output('right')]),
    LargeSharedOutputNew: schemaOf('LargeSharedOutputNew', [
      countInput('count'),
      outputFamily('images', 'count'),
      outputFamily('masks', 'count'),
    ]),
  }
  const outputResolve = (type: string): NodeSchema | undefined => outputSchemas[type]

  const copyRule: ReplacementRule = {
    from: 'FamilyOutputOld',
    cases: [{
      to: 'FamilyOutputNew',
      inputs: { quantity: { kind: 'copy', input: 'count' } },
      outputFamilies: { items: { kind: 'copy', sourceFamily: 'results' } },
    }],
  }

  it('copies ordered output members and atomically preserves links and named nets', () => {
    const original = doc({
      g0: graph({
        id: 'g0',
        nodes: {
          old: node('old', 'FamilyOutputOld', { count: 2 }),
          dst: node('dst', 'Consumer'),
        },
        links: {
          linked: link('linked', mport('old', 'results', '0'), port('dst', 'image')),
        },
        nets: {
          routed: net('routed', mport('old', 'results', '1'), [port('dst', 'mask')]),
        },
      }),
    })
    const planned = planReplacement(original, 'g0', 'old', copyRule, outputResolve)
    expect(planned.diagnostics).toEqual([])
    expect(planned.plan?.values).toEqual({ quantity: 2 })
    expect(planned.plan?.sourceCountGuards).toEqual({ count: 2 })
    expect(planned.plan?.outputRewires).toEqual([{
      link: 'linked',
      port: 'items',
      members: ['0'],
      fromPort: 'results',
      fromMembers: ['0'],
    }])
    expect(planned.plan?.netSourceRewires).toEqual([{
      net: 'routed',
      port: 'items',
      members: ['1'],
      fromPort: 'results',
      fromMembers: ['1'],
    }])

    const store = new DocumentStore(original, coreCommandRegistry())
    expect(store.dispatch({ command: 'node.replace', params: { plan: planned.plan! } as unknown as Json }).ok)
      .toBe(true)
    expect(store.doc.graphs.g0!.links.linked!.from).toEqual(mport('old', 'items', '0'))
    expect(store.doc.graphs.g0!.nets.routed!.source).toEqual(mport('old', 'items', '1'))
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(original)
    expect(store.redo()).toBe(true)
    expect(store.doc.graphs.g0!.links.linked!.from).toEqual(mport('old', 'items', '0'))
  })

  it('maps ordinary source outputs to explicit canonical target members', () => {
    const original = doc({
      g0: graph({
        id: 'g0',
        nodes: {
          old: node('old', 'StaticOutputOld'),
          dst: node('dst', 'Consumer'),
        },
        links: {
          left: link('left', port('old', 'left'), port('dst', 'a')),
          right: link('right', port('old', 'right'), port('dst', 'b')),
        },
        nets: {
          routed: net('routed', port('old', 'right'), [port('dst', 'routed')]),
        },
      }),
    })
    const rule: ReplacementRule = {
      from: 'StaticOutputOld',
      cases: [{
        to: 'FamilyOutputNew',
        inputs: { quantity: { kind: 'constant', value: 2 } },
        outputFamilies: {
          items: {
            kind: 'members',
            members: [{ suffix: '0', output: 'left' }, { suffix: '1', output: 'right' }],
          },
        },
      }],
    }
    const planned = planReplacement(original, 'g0', 'old', rule, outputResolve)
    expect(planned.diagnostics).toEqual([])
    expect(planned.plan?.outputRewires).toEqual([
      { link: 'left', port: 'items', members: ['0'], fromPort: 'left' },
      { link: 'right', port: 'items', members: ['1'], fromPort: 'right' },
    ])
    expect(planned.plan?.netSourceRewires).toEqual([
      { net: 'routed', port: 'items', members: ['1'], fromPort: 'right' },
    ])
    const store = new DocumentStore(original, coreCommandRegistry())
    expect(store.dispatch({ command: 'node.replace', params: { plan: planned.plan! } as unknown as Json }).ok)
      .toBe(true)
    expect(store.doc.graphs.g0!.links.left!.from).toEqual(mport('old', 'items', '0'))
    expect(store.doc.graphs.g0!.links.right!.from).toEqual(mport('old', 'items', '1'))
    expect(store.doc.graphs.g0!.nets.routed!.source).toEqual(mport('old', 'items', '1'))
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(original)

    const baseGraph = original.graphs.g0!
    const staleLink = {
      ...original,
      graphs: {
        ...original.graphs,
        g0: {
          ...baseGraph,
          links: {
            ...baseGraph.links,
            left: link('left', port('old', 'right'), port('dst', 'a')),
          },
        },
      },
    }
    const staleLinkStore = new DocumentStore(staleLink, coreCommandRegistry())
    expect(staleLinkStore.dispatch({ command: 'node.replace', params: { plan: planned.plan! } as unknown as Json }).ok)
      .toBe(false)
    expect(staleLinkStore.doc).toEqual(staleLink)

    const staleNet = {
      ...original,
      graphs: {
        ...original.graphs,
        g0: {
          ...baseGraph,
          nets: {
            ...baseGraph.nets,
            routed: net('routed', port('old', 'left'), [port('dst', 'routed')]),
          },
        },
      },
    }
    const staleNetStore = new DocumentStore(staleNet, coreCommandRegistry())
    expect(staleNetStore.dispatch({ command: 'node.replace', params: { plan: planned.plan! } as unknown as Json }).ok)
      .toBe(false)
    expect(staleNetStore.doc).toEqual(staleNet)
  })

  it('fails closed for linked source counts and stale member endpoints', () => {
    const linkedCount = doc({
      g0: graph({
        id: 'g0',
        nodes: {
          src: node('src', 'Producer'),
          old: node('old', 'FamilyOutputOld', { count: 1 }),
          dst: node('dst', 'Consumer'),
        },
        links: {
          count: link('count', port('src', 'out'), port('old', 'count')),
          result: link('result', mport('old', 'results', '0'), port('dst', 'in')),
        },
      }),
    })
    const rejected = planReplacement(linkedCount, 'g0', 'old', copyRule, outputResolve)
    expect(rejected.plan).toBeUndefined()
    expect(rejected.diagnostics).toContainEqual(expect.objectContaining({
      code: 'replace.source.outputFamilyInvalid',
    }))

    const original = doc({
      g0: graph({
        id: 'g0',
        nodes: { old: node('old', 'FamilyOutputOld', { count: 2 }), dst: node('dst', 'Consumer') },
        links: { result: link('result', mport('old', 'results', '0'), port('dst', 'in')) },
      }),
    })
    const plan = planReplacement(original, 'g0', 'old', copyRule, outputResolve).plan!
    expect(plan.sourceCountGuards).toEqual({ count: 2 })
    const baseGraph = original.graphs.g0!
    const stale = {
      ...original,
      graphs: {
        ...original.graphs,
        g0: {
          ...baseGraph,
          links: { ...baseGraph.links, result: link('result', mport('old', 'results', '1'), port('dst', 'in')) },
        },
      },
    }
    const store = new DocumentStore(stale, coreCommandRegistry())
    const applied = store.dispatch({ command: 'node.replace', params: { plan } as unknown as Json })
    expect(applied.ok).toBe(false)
    expect(applied.diagnostics).toContainEqual(expect.objectContaining({ code: 'replace.stale' }))
    expect(store.doc).toEqual(stale)

    const changedCount = {
      ...original,
      graphs: {
        ...original.graphs,
        g0: {
          ...baseGraph,
          nodes: {
            ...baseGraph.nodes,
            old: { ...baseGraph.nodes.old!, values: { count: 1 } },
          },
        },
      },
    }
    const linkedAfterPlanning = {
      ...original,
      graphs: {
        ...original.graphs,
        g0: {
          ...baseGraph,
          nodes: { ...baseGraph.nodes, src: node('src', 'Producer') },
          links: {
            ...baseGraph.links,
            count: link('count', port('src', 'out'), port('old', 'count')),
          },
        },
      },
    }
    const netAfterPlanning = {
      ...original,
      graphs: {
        ...original.graphs,
        g0: {
          ...baseGraph,
          nodes: { ...baseGraph.nodes, src: node('src', 'Producer') },
          nets: {
            ...baseGraph.nets,
            count: net('count', port('src', 'out'), [port('old', 'count')]),
          },
        },
      },
    }
    for (const current of [changedCount, linkedAfterPlanning, netAfterPlanning]) {
      const currentStore = new DocumentStore(current, coreCommandRegistry())
      const result = currentStore.dispatch({ command: 'node.replace', params: { plan } as unknown as Json })
      expect(result.ok).toBe(false)
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'replace.stale' }))
      expect(currentStore.doc).toEqual(current)
    }
  })

  it('rejects malformed output-family state in direct replacement plans', () => {
    const original = doc({
      g0: graph({
        id: 'g0',
        nodes: { old: node('old', 'FamilyOutputOld', { count: 1 }), dst: node('dst', 'Consumer') },
        links: { result: link('result', mport('old', 'results', '0'), port('dst', 'in')) },
        nets: { routed: net('routed', mport('old', 'results', '0'), [port('dst', 'routed')]) },
      }),
    })
    const plan = planReplacement(original, 'g0', 'old', copyRule, outputResolve).plan!
    const malformed = [
      { ...plan, sourceCountGuards: { count: '1' } },
      { ...plan, outputRewires: [{ ...plan.outputRewires[0]!, members: ['0', 'nested'] }] },
      { ...plan, outputRewires: [{ ...plan.outputRewires[0]!, fromMembers: ['0', 'nested'] }] },
      { ...plan, netSourceRewires: [{ ...plan.netSourceRewires[0]!, members: ['0', 'nested'] }] },
      { ...plan, netSourceRewires: [{ ...plan.netSourceRewires[0]!, fromMembers: ['0', 'nested'] }] },
    ]
    for (const candidate of malformed) {
      const store = new DocumentStore(original, coreCommandRegistry())
      const result = store.dispatch({
        command: 'node.replace',
        params: { plan: candidate } as unknown as Json,
      })
      expect(result.ok).toBe(false)
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'params.invalid' }))
      expect(store.doc).toEqual(original)
    }
  })

  it('rejects linked or invalid counts even when no output family is mapped', () => {
    const unconnected = doc({
      g0: graph({ id: 'g0', nodes: { old: node('old', 'CountSource', { count: 2 }) } }),
    })
    const linkedRule: ReplacementRule = {
      from: 'CountSource',
      cases: [{
        to: 'FamilyOutputNew',
        inputs: { quantity: { kind: 'link', input: 'count' } },
      }],
    }
    expect(planReplacement(unconnected, 'g0', 'old', linkedRule, outputResolve).diagnostics)
      .toContainEqual(expect.objectContaining({ code: 'replace.target.outputFamilyLinkedCount' }))

    const copyRuleWithoutOutputs: ReplacementRule = {
      from: 'CountSource',
      cases: [{
        to: 'FamilyOutputNew',
        inputs: { quantity: { kind: 'copy', input: 'count' } },
      }],
    }
    const linkedSource = doc({
      g0: graph({
        id: 'g0',
        nodes: { src: node('src', 'Producer'), old: node('old', 'CountSource', { count: 2 }) },
        links: { count: link('count', port('src', 'out'), port('old', 'count')) },
      }),
    })
    const netSource = doc({
      g0: graph({
        id: 'g0',
        nodes: { src: node('src', 'Producer'), old: node('old', 'CountSource', { count: 2 }) },
        nets: { count: net('count', port('src', 'out'), [port('old', 'count')]) },
      }),
    })
    for (const source of [linkedSource, netSource]) {
      const planned = planReplacement(source, 'g0', 'old', copyRuleWithoutOutputs, outputResolve)
      expect(planned.plan).toBeUndefined()
      expect(planned.diagnostics).toContainEqual(expect.objectContaining({
        code: 'replace.target.outputFamilyLinkedCount',
      }))
    }

    const overflowRule: ReplacementRule = {
      from: 'StaticOutputOld',
      cases: [{
        to: 'FamilyOutputNew',
        inputs: { quantity: { kind: 'constant', value: 513 } },
      }],
    }
    const staticSource = doc({
      g0: graph({ id: 'g0', nodes: { old: node('old', 'StaticOutputOld') } }),
    })
    expect(planReplacement(staticSource, 'g0', 'old', overflowRule, outputResolve).diagnostics)
      .toContainEqual(expect.objectContaining({ code: 'replace.target.outputFamilyInvalid' }))

    const helperOverflowRule: ReplacementRule = {
      from: 'StaticOutputOld',
      cases: [{
        to: 'StaticOutputOld',
        nodes: { family: { type: 'FamilyOutputNew' } },
        inputs: { 'family:quantity': { kind: 'constant', value: 513 } },
      }],
    }
    expect(planReplacement(staticSource, 'g0', 'old', helperOverflowRule, outputResolve).diagnostics)
      .toContainEqual(expect.objectContaining({ code: 'replace.target.outputFamilyInvalid' }))

    const valid = planReplacement(staticSource, 'g0', 'old', {
      ...overflowRule,
      cases: [{ to: 'FamilyOutputNew', inputs: { quantity: { kind: 'constant', value: 2 } } }],
    }, outputResolve)
    expect(valid.plan).toBeDefined()
    expect(valid.diagnostics).toEqual([])
  })

  it('rejects noncanonical suffixes and shared output-member budget overflow', () => {
    const original = doc({
      g0: graph({ id: 'g0', nodes: { old: node('old', 'StaticOutputOld') } }),
    })
    const noncanonical: ReplacementRule = {
      from: 'StaticOutputOld',
      cases: [{
        to: 'FamilyOutputNew',
        inputs: { quantity: { kind: 'constant', value: 1 } },
        outputFamilies: {
          items: { kind: 'members', members: [{ suffix: '1', output: 'left' }] },
        },
      }],
    }
    expect(planReplacement(original, 'g0', 'old', noncanonical, outputResolve).diagnostics)
      .toContainEqual(expect.objectContaining({ code: 'replace.target.outputFamilyMembers' }))

    const shared: ReplacementRule = {
      from: 'StaticOutputOld',
      cases: [{
        to: 'LargeSharedOutputNew',
        inputs: { count: { kind: 'constant', value: 300 } },
        outputFamilies: {
          images: { kind: 'members', members: Array.from({ length: 300 }, (_, index) => ({ suffix: String(index), output: `image${index}` })) },
          masks: { kind: 'members', members: Array.from({ length: 300 }, (_, index) => ({ suffix: String(index), output: `mask${index}` })) },
        },
      }],
    }
    const overflow = planReplacement(original, 'g0', 'old', shared, outputResolve)
    expect(overflow.plan).toBeUndefined()
    expect(overflow.diagnostics).toContainEqual(expect.objectContaining({
      code: 'replace.target.outputFamilyInvalid',
    }))
  })

  it('keeps unsupported nested output-member ancestry fail closed', () => {
    const original = doc({
      g0: graph({
        id: 'g0',
        nodes: { old: node('old', 'FamilyOutputOld', { count: 1 }), dst: node('dst', 'Consumer') },
        links: {
          nested: link('nested', {
            node: asNodeId('old'),
            port: asPortId('results'),
            members: [asDynamicMemberId('0'), asDynamicMemberId('nested')],
          }, port('dst', 'in')),
        },
      }),
    })
    const planned = planReplacement(original, 'g0', 'old', copyRule, outputResolve)
    expect(planned.plan?.dropLinks).toEqual(['nested'])
    expect(planned.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'warning',
      code: 'replace.dynamic.dropped',
    }))
  })
})

// ---------------------------------------------------------------------------
// node.replace command
// ---------------------------------------------------------------------------

describe('1-to-N replacement planning and apply', () => {
  const oneToNRule: ReplacementRule = {
    from: 'OldNode',
    note: 'expand around a list-native primary',
    cases: [{
      to: 'ListPrimary',
      nodes: {
        join: { type: 'ListJoin', values: { count: 2 } },
        split: { type: 'ListSplit' },
      },
      inputs: {
        'join:a': { kind: 'copy', input: 'in_image' },
        'join:b': { kind: 'copy', input: 'in_mask' },
        'join:scale': { kind: 'value', input: 'amount' },
      },
      links: [
        { from: 'join:items', to: 'images' },
        { from: 'items', to: 'split:items' },
      ],
      outputs: { 'split:first': 'out_image' },
    }],
  }

  function oneToNDoc(): WorkflowDocument {
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: {
          srcA: node('srcA', 'Producer'),
          srcB: node('srcB', 'Producer'),
          old: node('old', 'OldNode', { amount: 0.5 }, { controllers: { amount: 'increment' } }),
          dst: node('dst', 'Consumer'),
        },
        links: {
          l1: link('l1', port('srcA', 'out'), port('old', 'in_image')),
          l2: link('l2', port('srcB', 'out'), port('old', 'in_mask')),
          l3: link('l3', port('old', 'out_image'), port('dst', 'in')),
        },
      }),
    })
    return {
      ...d,
      view: { graphs: { g0: { nodes: { old: { position: { x: 40, y: 60 } } } } } },
    }
  }

  it('creates helpers, rewires helper addresses, records provenance, and places a deterministic view stack', () => {
    const before = oneToNDoc()
    const planned = planReplacement(before, 'g0', 'old', oneToNRule, resolve)
    expect(planned.diagnostics).toEqual([])
    expect(planned.plan!.createdNodes).toEqual([
      {
        nodeId: 'old:join',
        localId: 'join',
        type: 'ListJoin',
        values: { count: 2, scale: 0.5, untouched: 7 },
        controllers: { scale: 'increment' },
      },
      { nodeId: 'old:split', localId: 'split', type: 'ListSplit', values: {} },
    ])
    expect(planned.plan!.inputRewires).toEqual([
      { link: 'l1', node: 'old:join', port: 'a' },
      { link: 'l2', node: 'old:join', port: 'b' },
    ])
    expect(planned.plan!.outputRewires).toEqual([
      { link: 'l3', node: 'old:split', port: 'first' },
    ])
    expect(planned.plan!.links).toEqual([
      { from: port('old:join', 'items'), to: port('old', 'images') },
      { from: port('old', 'items'), to: port('old:split', 'items') },
    ])

    const store = new DocumentStore(before, coreCommandRegistry())
    expect(store.dispatch({ command: 'node.replace', params: { plan: planned.plan! } as unknown as Record<string, Json> }).ok).toBe(true)
    const g = store.doc.graphs.g0!
    expect(g.nodes.old!.type).toBe('ListPrimary')
    expect(g.nodes['old:join']).toMatchObject({ type: 'ListJoin', values: { count: 2, scale: 0.5, untouched: 7 } })
    expect(g.nodes['old:split']).toMatchObject({ type: 'ListSplit', values: {} })
    expect(g.links.l1!.to).toEqual(port('old:join', 'a'))
    expect(g.links.l2!.to).toEqual(port('old:join', 'b'))
    expect(g.links.l3!.from).toEqual(port('old:split', 'first'))
    expect(g.links.l100).toMatchObject({ from: port('old:join', 'items'), to: port('old', 'images') })
    expect(g.links.l101).toMatchObject({ from: port('old', 'items'), to: port('old:split', 'items') })
    expect(store.doc.view.graphs.g0!.nodes['old:join']!.position).toEqual({ x: 360, y: 60 })
    expect(store.doc.view.graphs.g0!.nodes['old:split']!.position).toEqual({ x: 360, y: 240 })
    expect(checkDocument(store.doc)).toEqual([])
    expect(store.undo()).toBe(true)
    // Allocation cursors are monotonic across undo; all semantic/view state restores.
    expect(store.doc.graphs.g0!.nextOrdinal).toBe(102)
    expect({
      ...store.doc,
      graphs: { ...store.doc.graphs, g0: { ...store.doc.graphs.g0!, nextOrdinal: 100 } },
    }).toEqual(before)
  })

  it('rejects a helper-id collision while planning', () => {
    const d = oneToNDoc()
    const g = d.graphs.g0!
    const collided = {
      ...d,
      graphs: { ...d.graphs, g0: { ...g, nodes: { ...g.nodes, 'old:join': node('old:join', 'Other') } } },
    }
    const out = planReplacement(collided, 'g0', 'old', oneToNRule, resolve)
    expect(out.plan).toBeUndefined()
    expect(out.diagnostics.some((d) => d.code === 'replace.helper.collision')).toBe(true)
  })

  it('rejects helper ids colliding with any graph id and rechecks at apply', () => {
    const d = oneToNDoc()
    const g = d.graphs.g0!
    const collidingLink = link('old:join', port('srcA', 'out'), port('dst', 'other'))
    const collided = {
      ...d,
      graphs: { ...d.graphs, g0: { ...g, links: { ...g.links, 'old:join': collidingLink } } },
    }
    const plannedCollision = planReplacement(collided, 'g0', 'old', oneToNRule, resolve)
    expect(plannedCollision.plan).toBeUndefined()
    expect(plannedCollision.diagnostics.some((diagnostic) => diagnostic.code === 'replace.helper.collision')).toBe(true)

    const plan = planReplacement(d, 'g0', 'old', oneToNRule, resolve).plan!
    const store = new DocumentStore(collided, coreCommandRegistry())
    const applied = store.dispatch({ command: 'node.replace', params: { plan } as unknown as Record<string, Json> })
    expect(applied.ok).toBe(false)
    if (!applied.ok) expect(applied.diagnostics[0]!.code).toBe('replace.stale')
    expect(store.doc).toEqual(collided)
  })

  it('rejects apply when a derived helper id appears after planning', () => {
    const d = oneToNDoc()
    const plan = planReplacement(d, 'g0', 'old', oneToNRule, resolve).plan!
    const g = d.graphs.g0!
    const mutated = {
      ...d,
      graphs: { ...d.graphs, g0: { ...g, nodes: { ...g.nodes, 'old:join': node('old:join', 'Other') } } },
    }
    const store = new DocumentStore(mutated, coreCommandRegistry())
    const out = store.dispatch({ command: 'node.replace', params: { plan } as unknown as Record<string, Json> })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.diagnostics[0]!.code).toBe('replace.stale')
    expect(store.doc).toEqual(mutated)
  })

  it('rejects unknown helper ports and boundary retargeting to a helper', () => {
    const badPort: ReplacementRule = {
      from: 'OldNode',
      cases: [{
        to: 'ListPrimary',
        nodes: { join: { type: 'ListJoin' } },
        inputs: { 'join:nope': { kind: 'copy', input: 'in_image' } },
      }],
    }
    expect(
      planReplacement(oneToNDoc(), 'g0', 'old', badPort, resolve).diagnostics.some(
        (d) => d.code === 'replace.target.inputMissing',
      ),
    ).toBe(true)

    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { old: node('old', 'OldNode') },
        boundary: {
          inputs: [{ id: 'bound', binds: { kind: 'port' as const, ...port('old', 'in_image') } }],
          outputs: [],
        },
      }),
    })
    const boundaryRule: ReplacementRule = {
      from: 'OldNode',
      cases: [{
        to: 'ListPrimary',
        nodes: { join: { type: 'ListJoin' } },
        inputs: { 'join:a': { kind: 'copy', input: 'in_image' } },
      }],
    }
    const out = planReplacement(d, 'g0', 'old', boundaryRule, resolve)
    expect(out.plan).toBeUndefined()
    expect(out.diagnostics.some((d) => d.code === 'replace.boundary.helper')).toBe(true)
  })

  it('rejects unknown helper types and helper constants on widget-less inputs', () => {
    const d = oneToNDoc()
    const unknown: ReplacementRule = {
      from: 'OldNode',
      cases: [{ to: 'ListPrimary', nodes: { helper: { type: 'MissingHelper' } } }],
    }
    expect(
      planReplacement(d, 'g0', 'old', unknown, resolve).diagnostics.some(
        (diagnostic) => diagnostic.code === 'replace.target.unknown',
      ),
    ).toBe(true)

    const noWidget: ReplacementRule = {
      from: 'OldNode',
      cases: [{
        to: 'ListPrimary',
        nodes: { helper: { type: 'ListJoin', values: { a: 1 } } },
      }],
    }
    expect(
      planReplacement(d, 'g0', 'old', noWidget, resolve).diagnostics.some(
        (diagnostic) => diagnostic.code === 'replace.target.notWidget',
      ),
    ).toBe(true)
  })

  it('rewires helper net sinks and sources without reordering unaffected sinks', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: {
          src: node('src', 'Producer'),
          old: node('old', 'OldNode'),
          dst: node('dst', 'Consumer'),
        },
        nets: {
          incoming: net('incoming', port('src', 'out'), [port('old', 'in_image'), port('dst', 'other')]),
          outgoing: net('outgoing', port('old', 'out_image'), [port('dst', 'in')]),
        },
      }),
    })
    const plan = planReplacement(d, 'g0', 'old', oneToNRule, resolve).plan!
    expect(plan.netSinks).toEqual([
      { net: 'incoming', sinks: [port('old:join', 'a'), port('dst', 'other')] },
    ])
    expect(plan.netSourceRewires).toEqual([
      { net: 'outgoing', node: 'old:split', port: 'first' },
    ])

    const store = new DocumentStore(d, coreCommandRegistry())
    expect(store.dispatch({ command: 'node.replace', params: { plan } as unknown as Record<string, Json> }).ok).toBe(true)
    expect(store.doc.graphs.g0!.nets.incoming!.sinks).toEqual([
      port('old:join', 'a'),
      port('dst', 'other'),
    ])
    expect(store.doc.graphs.g0!.nets.outgoing!.source).toEqual(port('old:split', 'first'))
  })

  it('preserves both helper sinks when batched replacements share one net', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: {
          src: node('src', 'Producer'),
          a: node('a', 'OldNode'),
          b: node('b', 'OldNode'),
        },
        nets: {
          shared: net('shared', port('src', 'out'), [port('a', 'in_image'), port('b', 'in_image')]),
        },
      }),
    })
    const registry = createReplacementRegistry()
    expect(registry.register('core', oneToNRule)).toEqual([])
    const items = scanReplacements(d, registry, resolve)
    const store = new DocumentStore(d, coreCommandRegistry())
    expect(store.dispatch(replacementInvocation(items)!).ok).toBe(true)
    expect(store.doc.graphs.g0!.nets.shared!.sinks).toEqual([
      port('a:join', 'a'),
      port('b:join', 'a'),
    ])
  })

  it('composes shared-net rewrites when additive mode declares an empty nodes map', () => {
    const rule: ReplacementRule = {
      from: 'OldNode',
      cases: [{
        to: 'NewNode',
        nodes: {},
        inputs: { image: { kind: 'copy', input: 'in_image' } },
      }],
    }
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { src: node('src', 'Producer'), a: node('a', 'OldNode'), b: node('b', 'OldNode') },
        nets: { shared: net('shared', port('src', 'out'), [port('a', 'in_image'), port('b', 'in_image')]) },
      }),
    })
    const registry = createReplacementRegistry()
    expect(registry.register('core', rule)).toEqual([])
    const store = new DocumentStore(d, coreCommandRegistry())
    expect(store.dispatch(replacementInvocation(scanReplacements(d, registry, resolve))!).ok).toBe(true)
    expect(store.doc.graphs.g0!.nets.shared!.sinks).toEqual([
      port('a', 'image'),
      port('b', 'image'),
    ])
  })

  it('uses the fallback origin and actor-scoped link allocation', () => {
    const d = doc({ g0: graph({ id: 'g0', nodes: { old: node('old', 'OldNode') } }) })
    const plan = planReplacement(d, 'g0', 'old', oneToNRule, resolve).plan!
    const store = new DocumentStore(d, coreCommandRegistry())
    expect(
      store.dispatch({
        command: 'node.replace',
        params: { plan } as unknown as Record<string, Json>,
        actor: 'alice',
      }).ok,
    ).toBe(true)
    expect(store.doc.view.graphs.g0!.nodes['old:join']!.position).toEqual({ x: 320, y: 0 })
    expect(store.doc.view.graphs.g0!.nodes['old:split']!.position).toEqual({ x: 320, y: 180 })
    expect(store.doc.graphs.g0!.links['l0-alice']).toBeDefined()
    expect(store.doc.graphs.g0!.links['l1-alice']).toBeDefined()
    expect(store.doc.graphs.g0!.actorCursors).toEqual({ alice: 2 })
    expect(store.doc.graphs.g0!.nextOrdinal).toBe(100)
  })

  it('keeps legacy colon-containing primary ports valid when nodes is absent', () => {
    const rule: ReplacementRule = {
      from: 'OldNode',
      cases: [{
        to: 'LegacyColon',
        inputs: { 'in:old': { kind: 'copy', input: 'in_image' } },
        outputs: { 'out:old': 'out_image' },
      }],
    }
    expect(isReplacementRule(rule)).toBe(true)
    const plan = planReplacement(wiredDoc(), 'g0', 'old', rule, resolve).plan!
    expect(plan.inputRewires).toEqual([{ link: 'l1', port: 'in:old' }])
    expect(plan.outputRewires).toEqual([
      { link: 'l2', port: 'out:old' },
      { link: 'l3', port: 'out:old' },
    ])
    expect('createdNodes' in plan).toBe(false)
    expect('links' in plan).toBe(false)
  })

  it('rejects malformed created-node plans and unrelated new endpoints atomically', () => {
    const d = oneToNDoc()
    const plan = planReplacement(d, 'g0', 'old', oneToNRule, resolve).plan!
    const malformed = [
      {
        ...plan,
        createdNodes: [
          ...plan.createdNodes!,
          { ...plan.createdNodes![0]!, nodeId: 'old:join' },
        ],
      },
      {
        ...plan,
        createdNodes: [{ ...plan.createdNodes![0]!, controllers: { scale: 'invalid' } }],
      },
      {
        ...plan,
        dynamic: { mode: { selected: 7 } },
      },
      {
        ...plan,
        createdNodes: [{
          ...plan.createdNodes![0]!,
          dynamic: { items: { memberState: { a: { nested: { selected: 7 } } } } },
        }],
      },
      {
        ...plan,
        inputRewires: [{ ...plan.inputRewires[0]!, node: 'unrelated' }],
      },
      {
        ...plan,
        links: [{ from: { node: 'unrelated', port: 'out' }, to: port('old', 'images') }],
      },
      {
        ...plan,
        links: [{ from: { ...port('old:join', 'items'), members: ['m1'] }, to: port('old', 'images') }],
      },
    ]
    for (const candidate of malformed) {
      const store = new DocumentStore(d, coreCommandRegistry())
      const out = store.dispatch({
        command: 'node.replace',
        params: { plan: candidate } as unknown as Record<string, Json>,
      })
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.diagnostics[0]!.code).toBe('params.invalid')
      expect(store.doc).toEqual(d)
    }
  })

  it('blocks a later primary hop that references allocator-created internal links', () => {
    const migratePrimary: ReplacementRule = {
      from: 'ListPrimary',
      cases: [{ to: 'SamePorts' }],
    }
    const registry = createReplacementRegistry()
    expect(registry.register('core', oneToNRule)).toEqual([])
    expect(registry.register('core', migratePrimary)).toEqual([])
    const items = scanReplacements(oneToNDoc(), registry, resolve)
    expect(items[0]!.status).toBe('blocked')
    expect(items[0]!.hops).toHaveLength(1)
    expect(items[0]!.diagnostics.some((diagnostic) => diagnostic.code === 'replace.chain.createdLink')).toBe(true)
  })

  it('keeps a case without nodes or links byte-identical to the 1-to-1 plan shape', () => {
    const plan = planReplacement(wiredDoc(), 'g0', 'old', basicRule, resolve).plan!
    expect(plan).toEqual({
      graphId: 'g0',
      nodeId: 'old',
      from: 'OldNode',
      to: 'NewNode',
      caseIndex: 0,
      values: { strength: 0.5, mode: 'bilinear' },
      inputRewires: [{ link: 'l1', port: 'image' }],
      outputRewires: [
        { link: 'l2', port: 'image' },
        { link: 'l3', port: 'image' },
      ],
      dropLinks: [],
      netSourceRewires: [],
      netSinks: [],
      dropNets: [],
    })
    expect('createdNodes' in plan).toBe(false)
    expect('links' in plan).toBe(false)
  })
})

describe('node.replace', () => {
  function storeWith(d: WorkflowDocument) {
    return new DocumentStore(d, coreCommandRegistry())
  }

  function planFor(store: DocumentStore, rule = basicRule): NodeReplacePlan {
    const out = planReplacement(store.doc, 'g0', 'old', rule, resolve)
    expect(out.plan).toBeDefined()
    return out.plan!
  }

  it('applies a plan atomically: node identity, values, links, one undo step', () => {
    const store = storeWith(
      doc({
        g0: graph({
          id: 'g0',
          nodes: {
            src: node('src', 'Producer'),
            old: node('old', 'OldNode', { amount: 0.5 }, { title: 'My Old', mode: 'muted', ext: { pack: { keep: true } }, dynamic: { items: { members: [] } } }),
            dst: node('dst', 'Consumer'),
          },
          links: {
            l1: link('l1', port('src', 'out'), port('old', 'in_image')),
            l2: link('l2', port('old', 'out_image'), port('dst', 'in')),
          },
        }),
      }),
    )
    const before = store.doc
    const plan = planFor(store)
    const out = store.dispatch({ command: 'node.replace', params: { plan } as unknown as Record<string, Json> })
    expect(out.ok).toBe(true)

    const g = store.doc.graphs.g0!
    const n = g.nodes.old!
    expect(n.type).toBe('NewNode')
    expect(n.values).toEqual({ strength: 0.5, mode: 'bilinear' })
    expect(n.title).toBe('My Old') // identity survives
    expect(n.mode).toBe('muted')
    expect(n.ext).toEqual({ pack: { keep: true } })
    expect(n.dynamic).toBeUndefined() // dynamic state dropped
    expect(g.links.l1!.to).toEqual(port('old', 'image'))
    expect(g.links.l2!.from).toEqual(port('old', 'image'))
    expect(checkDocument(store.doc)).toEqual([])

    // ONE undo restores the exact pre-replacement document.
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(before)
  })

  it('applies net rewrites and drops, keeping invariants green', () => {
    const store = storeWith(
      {
        ...doc({
          g0: graph({
            id: 'g0',
            nodes: { src: node('src', 'P'), old: node('old', 'OldNode'), dst: node('dst', 'C') },
            nets: {
              netIn: net('netIn', port('src', 'out'), [port('old', 'in_image'), port('dst', 'other')]),
              netOut: net('netOut', port('old', 'out_image'), [port('dst', 'in')]),
            },
          }),
        }),
        ext: { 'dinkster.netViews': [
          { graphId: 'g0', netId: 'netIn', role: 'source', position: { x: 10, y: 20 } },
          { graphId: 'g0', netId: 'netIn', role: 'sink', to: { node: 'old', port: 'in_image' }, position: { x: 30, y: 40 } },
          { graphId: 'g0', netId: 'netIn', role: 'sink', to: { node: 'dst', port: 'other' }, position: { x: 50, y: 60 } },
          { graphId: 'g0', netId: 'netOut', role: 'source', position: { x: 70, y: 80 } },
        ] },
      },
    )
    const plan = planFor(store)
    expect(plan.netSinkEdits).toEqual([
      { net: 'netIn', from: port('old', 'in_image'), to: port('old', 'image') },
    ])
    expect(store.dispatch({ command: 'node.replace', params: { plan } as unknown as Record<string, Json> }).ok).toBe(true)
    const g = store.doc.graphs.g0!
    expect(g.nets.netIn!.sinks).toEqual([port('old', 'image'), port('dst', 'other')])
    expect(g.nets.netOut!.source).toEqual(port('old', 'image'))
    expect(netViewPositions(store.doc, 'g0')).toEqual([
      { graphId: 'g0', netId: 'netIn', role: 'source', geometry: { kind: 'absolute', x: 10, y: 20 } },
      { graphId: 'g0', netId: 'netIn', role: 'sink', to: port('dst', 'other'), geometry: { kind: 'absolute', x: 50, y: 60 } },
      { graphId: 'g0', netId: 'netOut', role: 'source', geometry: { kind: 'absolute', x: 70, y: 80 } },
    ])
    expect(checkDocument(store.doc)).toEqual([])
  })

  it('drops authored views for replacement-pruned sinks and nets', () => {
    const lossy: ReplacementRule = { from: 'OldNode', cases: [{ to: 'NewNode' }] }
    const initial = doc({
      g0: graph({
        id: 'g0',
        nodes: { src: node('src', 'P'), old: node('old', 'OldNode'), dst: node('dst', 'C') },
        nets: {
          netIn: net('netIn', port('src', 'out'), [port('old', 'in_image'), port('dst', 'other')]),
          netOut: net('netOut', port('old', 'out_image'), [port('dst', 'in')]),
        },
      }),
    })
    const store = storeWith({
      ...initial,
      ext: { 'dinkster.netViews': [
        { graphId: 'g0', netId: 'netIn', role: 'sink', to: { node: 'old', port: 'in_image' }, position: { x: 10, y: 20 } },
        { graphId: 'g0', netId: 'netIn', role: 'sink', to: { node: 'dst', port: 'other' }, position: { x: 30, y: 40 } },
        { graphId: 'g0', netId: 'netOut', role: 'source', position: { x: 50, y: 60 } },
        { graphId: 'g0', netId: 'netOut', role: 'sink', to: { node: 'dst', port: 'in' }, position: { x: 70, y: 80 } },
      ] },
    })
    const before = store.doc
    const plan = planFor(store, lossy)

    expect(store.dispatch({ command: 'node.replace', params: { plan } as unknown as Record<string, Json> }).ok).toBe(true)
    expect(netViewPositions(store.doc, 'g0')).toEqual([
      { graphId: 'g0', netId: 'netIn', role: 'sink', to: port('dst', 'other'), geometry: { kind: 'absolute', x: 30, y: 40 } },
    ])
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(before)
  })

  it('replaces controllers wholesale (stale source controllers never linger)', () => {
    const rule: ReplacementRule = {
      from: 'OldSeeded',
      cases: [{ to: 'SeededNode', inputs: { seed: { kind: 'value', input: 'noise_seed' } } }],
    }
    const store = storeWith(
      doc({
        g0: graph({
          id: 'g0',
          nodes: { old: node('old', 'OldSeeded', { noise_seed: 7 }, { controllers: { noise_seed: 'increment' } }) },
        }),
      }),
    )
    const out = planReplacement(store.doc, 'g0', 'old', rule, resolve)
    expect(store.dispatch({ command: 'node.replace', params: { plan: out.plan! } as unknown as Record<string, Json> }).ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes.old!.controllers).toEqual({ seed: 'increment' })
  })

  it('rejects a stale plan (type changed) without mutating', () => {
    const store = storeWith(wiredDoc())
    const plan = planFor(store)
    const stale = { ...plan, from: 'SomethingElse' }
    const out = store.dispatch({ command: 'node.replace', params: { plan: stale } as unknown as Record<string, Json> })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.diagnostics[0]!.code).toBe('replace.stale')
    expect(store.revision).toBe(0)
    expect(store.doc).toEqual(wiredDoc())
  })

  it('rejects a stale plan (referenced link gone) without mutating', () => {
    const store = storeWith(wiredDoc())
    const plan = planFor(store)
    expect(store.dispatch({ command: 'link.disconnect', params: { graphId: 'g0', linkId: 'l1' } }).ok).toBe(true)
    const before = store.doc
    const out = store.dispatch({ command: 'node.replace', params: { plan } as unknown as Record<string, Json> })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.diagnostics[0]!.code).toBe('replace.stale')
    expect(store.doc).toBe(before)
  })

  it('rejects a plan whose rewired endpoint grew a member path', () => {
    const d = wiredDoc()
    const store = storeWith(d)
    const plan = planFor(store)
    // Simulate a concurrent edit that re-pointed l1 at a dynamic member.
    const g = d.graphs.g0!
    const mutated = {
      ...d,
      graphs: {
        ...d.graphs,
        g0: { ...g, links: { ...g.links, l1: link('l1', port('src', 'out'), mport('old', 'in_image', 'm1')) } },
      },
    }
    const store2 = storeWith(mutated)
    const out = store2.dispatch({ command: 'node.replace', params: { plan } as unknown as Record<string, Json> })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.diagnostics[0]!.code).toBe('replace.stale')
  })

  it('rejects malformed params', () => {
    const store = storeWith(wiredDoc())
    const out = store.dispatch({ command: 'node.replace', params: { plan: { graphId: 'g0' } } })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.diagnostics[0]!.code).toBe('params.invalid')
  })

  /** Subgraph doc: root g0 holds an instance of g1; g1's boundary binds 'old'. */
  function boundDoc(): WorkflowDocument {
    return doc(
      {
        g0: graph({ id: 'g0', nodes: { inst: node('inst', '#g1') } }),
        g1: graph({
          id: 'g1',
          nodes: { keep: node('keep', 'Other'), old: node('old', 'OldNode', { amount: 0.5 }) },
          boundary: {
            inputs: [{
              id: 'bi',
              binds: { kind: 'port' as const, ...port('old', 'in_image') },
              promoted: false,
            }, {
              id: 'bi2',
              displayName: 'Fan out',
              binds: { kind: 'port' as const, ...port('keep', 'in_image') },
              alsoBinds: [{ kind: 'port' as const, ...port('old', 'in_image') }],
            }],
            outputs: [{ id: 'bo', binds: { kind: 'port' as const, ...port('old', 'out_image') } }],
          },
        }),
      },
      'g0',
    )
  }

  it('migrates boundary bindings atomically and restores them on undo', () => {
    const store = storeWith(boundDoc())
    const before = store.doc
    const out = planReplacement(store.doc, 'g1', 'old', basicRule, resolve)
    expect(out.plan!.boundaryRewires).toEqual([
      { item: 'bi', side: 'input', fromPort: 'in_image', port: 'image' },
      { item: 'bi2', side: 'input', fromPort: 'in_image', port: 'image', alsoIndex: 0 },
      { item: 'bo', side: 'output', fromPort: 'out_image', port: 'image' },
    ])
    expect(store.dispatch({ command: 'node.replace', params: { plan: out.plan! } as unknown as Record<string, Json> }).ok).toBe(true)

    const b = store.doc.graphs.g1!.boundary!
    expect(b.inputs[0]).toEqual({ id: 'bi', binds: { kind: 'port', ...port('old', 'image') }, promoted: false })
    expect(b.inputs[1]).toEqual({
      id: 'bi2',
      displayName: 'Fan out',
      binds: { kind: 'port', ...port('keep', 'in_image') }, // untouched: other node
      alsoBinds: [{ kind: 'port', ...port('old', 'image') }],
    })
    expect(b.outputs[0]).toEqual({ id: 'bo', binds: { kind: 'port', ...port('old', 'image') } })
    expect(store.doc.graphs.g1!.nodes.old!.type).toBe('NewNode')
    expect(checkDocument(store.doc)).toEqual([])

    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(before)
  })

  it('rejects a plan whose boundary binding was detached since planning', () => {
    const store = storeWith(boundDoc())
    const out = planReplacement(store.doc, 'g1', 'old', basicRule, resolve)
    // Simulate a concurrent boundary edit: 'bi' rebound to another node.
    const d = store.doc
    const g1 = d.graphs.g1!
    const mutated = {
      ...d,
      graphs: {
        ...d.graphs,
        g1: {
          ...g1,
          boundary: {
            inputs: [{ id: 'bi', binds: { kind: 'port' as const, ...port('keep', 'in_image') } }, g1.boundary!.inputs[1]!],
            outputs: g1.boundary!.outputs,
          },
        },
      },
    }
    const store2 = storeWith(mutated)
    const res = store2.dispatch({ command: 'node.replace', params: { plan: out.plan! } as unknown as Record<string, Json> })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.diagnostics[0]!.code).toBe('replace.stale')
    expect(store2.doc).toEqual(mutated)
  })

  it('rejects a plan when an IDENTITY-mapped boundary binding changed since planning (guard)', () => {
    // A same-port rule produces NO boundaryRewires (nothing to migrate), so
    // the per-rewire staleness check has nothing to look at. Only the guard
    // snapshot can notice that a binding moved after planning.
    const samePortRule: ReplacementRule = {
      from: 'OldNode',
      cases: [
        {
          to: 'SamePorts',
          inputs: { in_image: { kind: 'copy', input: 'in_image' } },
          outputs: { out_image: 'out_image' },
        },
      ],
    }
    const base = boundDoc()
    const g1base = base.graphs.g1!
    const out = planReplacement(base, 'g1', 'old', samePortRule, resolve)
    expect(out.plan!.boundaryRewires).toBeUndefined()
    expect(out.plan!.boundaryGuard).toBeDefined()
    // Concurrent edit: 'bi' still binds the node, but on a different port.
    const mutated = {
      ...base,
      graphs: {
        ...base.graphs,
        g1: {
          ...g1base,
          boundary: {
            inputs: [{
              ...g1base.boundary!.inputs[0]!,
              binds: { kind: 'port' as const, ...port('old', 'amount') },
            }, g1base.boundary!.inputs[1]!],
            outputs: g1base.boundary!.outputs,
          },
        },
      },
    }
    const store2 = storeWith(mutated)
    const res = store2.dispatch({ command: 'node.replace', params: { plan: out.plan! } as unknown as Record<string, Json> })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.diagnostics[0]!.code).toBe('replace.stale')
    expect(store2.doc).toEqual(mutated)
  })

  it('rejects a plan when a NEW boundary binding to the node appeared after planning (guard)', () => {
    const base = boundDoc()
    const g1base = base.graphs.g1!
    const store = storeWith(base)
    const out = planReplacement(store.doc, 'g1', 'old', basicRule, resolve)
    const mutated = {
      ...base,
      graphs: {
        ...base.graphs,
        g1: {
          ...g1base,
          boundary: {
            inputs: [...g1base.boundary!.inputs, {
              id: 'bi3',
              binds: { kind: 'port' as const, ...port('old', 'in_image') },
            }],
            outputs: g1base.boundary!.outputs,
          },
        },
      },
    }
    const store2 = storeWith(mutated)
    const res = store2.dispatch({ command: 'node.replace', params: { plan: out.plan! } as unknown as Record<string, Json> })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.diagnostics[0]!.code).toBe('replace.stale')
    expect(store2.doc).toEqual(mutated)
  })

  it('rejects a plan when a boundary binding to the node was REMOVED after planning (guard)', () => {
    // Use a same-port rule so the plan carries no rewires at all: dropping
    // bi2's alsoBinds[0] (bound to the node at plan time) then leaves nothing
    // for the per-rewire check to trip over - only the guard sees the
    // snapshot shrink.
    const samePortRule: ReplacementRule = {
      from: 'OldNode',
      cases: [
        {
          to: 'SamePorts',
          inputs: { in_image: { kind: 'copy', input: 'in_image' } },
          outputs: { out_image: 'out_image' },
        },
      ],
    }
    const base = boundDoc()
    const g1base = base.graphs.g1!
    const out = planReplacement(base, 'g1', 'old', samePortRule, resolve)
    expect(out.plan!.boundaryRewires).toBeUndefined()
    // Concurrent edit: bi2's alsoBinds entry to the node is gone entirely.
    const mutated = {
      ...base,
      graphs: {
        ...base.graphs,
        g1: {
          ...g1base,
          boundary: {
            inputs: [g1base.boundary!.inputs[0]!, {
              ...g1base.boundary!.inputs[1]!,
              alsoBinds: [],
            }],
            outputs: g1base.boundary!.outputs,
          },
        },
      },
    }
    const store2 = storeWith(mutated)
    const res = store2.dispatch({ command: 'node.replace', params: { plan: out.plan! } as unknown as Record<string, Json> })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.diagnostics[0]!.code).toBe('replace.stale')
    expect(store2.doc).toEqual(mutated)
  })

  it('rejects a plan when a boundary promotion flipped after planning (guard)', () => {
    // The planner checks promoted bindings target a widget input; flipping
    // promoted afterwards would bypass that check without the guard.
    const base = boundDoc()
    const g1base = base.graphs.g1!
    const store = storeWith(base)
    const out = planReplacement(store.doc, 'g1', 'old', basicRule, resolve)
    const mutated = {
      ...base,
      graphs: {
        ...base.graphs,
        g1: {
          ...g1base,
          boundary: {
            inputs: [{ ...g1base.boundary!.inputs[0]!, promoted: true }, g1base.boundary!.inputs[1]!],
            outputs: g1base.boundary!.outputs,
          },
        },
      },
    }
    const store2 = storeWith(mutated)
    const res = store2.dispatch({ command: 'node.replace', params: { plan: out.plan! } as unknown as Record<string, Json> })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.diagnostics[0]!.code).toBe('replace.stale')
    expect(store2.doc).toEqual(mutated)
  })

  it('guard keys are injective: NUL bytes in ids/ports cannot collide two entries', () => {
    // A concatenation-based key would let ('bi', '-1\u0000p') and
    // ('bi\u0000-1', 'p') pack to the same string, so a mutation shifting
    // text between item id and port would slip past. JSON tuple keys cannot.
    const emptyPlan = {
      graphId: 'g1', nodeId: 'old', from: 'OldNode', to: 'SamePorts', values: {},
      inputRewires: [], outputRewires: [], dropLinks: [], netSourceRewires: [], netSinks: [], dropNets: [],
      boundaryGuard: [{ item: 'bi\u0000-1', side: 'input', port: 'p' }],
    }
    const base = boundDoc()
    const g1base = base.graphs.g1!
    const mutated = {
      ...base,
      graphs: {
        ...base.graphs,
        g1: {
          ...g1base,
          boundary: {
            inputs: [{ id: 'bi', binds: { kind: 'port' as const, ...port('old', '-1\u0000p') } }],
            outputs: [],
          },
        },
      },
    }
    const store = storeWith(mutated)
    const res = store.dispatch({ command: 'node.replace', params: { plan: emptyPlan } as unknown as Record<string, Json> })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.diagnostics[0]!.code).toBe('replace.stale')
    expect(store.doc).toEqual(mutated)
  })

  it('guard comparison keeps multiplicity: duplicated keys cannot mask a vanished binding', () => {
    // Planned snapshot: two DISTINCT bindings. Current boundary: two COPIES
    // of the first. A set-membership check would pass (every current key is
    // in the expected set, lengths equal); sorted comparison must not.
    const emptyPlan = {
      graphId: 'g1', nodeId: 'old', from: 'OldNode', to: 'SamePorts', values: {},
      inputRewires: [], outputRewires: [], dropLinks: [], netSourceRewires: [], netSinks: [], dropNets: [],
      boundaryGuard: [
        { item: 'bi', side: 'input', port: 'in_image' },
        { item: 'bi2', side: 'input', port: 'in_image' },
      ],
    }
    const base = boundDoc()
    const g1base = base.graphs.g1!
    const mutated = {
      ...base,
      graphs: {
        ...base.graphs,
        g1: {
          ...g1base,
          boundary: {
            inputs: [
              { id: 'bi', binds: { kind: 'port' as const, ...port('old', 'in_image') } },
              { id: 'bi', binds: { kind: 'port' as const, ...port('old', 'in_image') } },
            ],
            outputs: [],
          },
        },
      },
    }
    const store = storeWith(mutated)
    const res = store.dispatch({ command: 'node.replace', params: { plan: emptyPlan } as unknown as Record<string, Json> })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.diagnostics[0]!.code).toBe('replace.stale')
    expect(store.doc).toEqual(mutated)
  })

  it('rejects a plan whose boundary binding kept the node but changed port since planning', () => {
    const store = storeWith(boundDoc())
    const out = planReplacement(store.doc, 'g1', 'old', basicRule, resolve)
    // Same item, same node, still a static port binding - but the port moved
    // after planning. Applying would silently overwrite the new port.
    const d = store.doc
    const g1 = d.graphs.g1!
    const mutated = {
      ...d,
      graphs: {
        ...d.graphs,
        g1: {
          ...g1,
          boundary: {
            inputs: [{ id: 'bi', binds: { kind: 'port' as const, ...port('old', 'in_mask') } }, g1.boundary!.inputs[1]!],
            outputs: g1.boundary!.outputs,
          },
        },
      },
    }
    const store2 = storeWith(mutated)
    const res = store2.dispatch({ command: 'node.replace', params: { plan: out.plan! } as unknown as Record<string, Json> })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.diagnostics[0]!.code).toBe('replace.stale')
    expect(store2.doc).toEqual(mutated)
  })
})

describe('import.replaceComfyGroups', () => {
  it('rolls back the collapsed graph when native replacement fails', () => {
    const source = {
      ...doc({
        g0: graph({ id: 'g0', nodes: { old: node('old', 'OldNode', { amount: 1 }) } }),
      }),
      view: { graphs: { g0: { nodes: {} } } },
    } satisfies WorkflowDocument
    const collapsed = {
      ...doc({
        g0: graph({ id: 'g0', nodes: { old: node('old', 'OldNode', { amount: 2 }) } }),
      }),
      view: { graphs: { g0: { nodes: {} } } },
    } satisfies WorkflowDocument
    const planned = planReplacement(collapsed, 'g0', 'old', basicRule, resolve).plan!
    const stale = { ...planned, from: 'comfy-group.test' }
    const invocation = comfyGroupReplacementInvocation(source, collapsed, [stale])!
    const store = new DocumentStore(source, coreCommandRegistry())

    const outcome = store.dispatch(invocation)

    expect(outcome.ok).toBe(false)
    expect(outcome.diagnostics).toContainEqual(expect.objectContaining({ code: 'replace.stale' }))
    expect(store.doc).toEqual(source)
    expect(store.revision).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Scan + apply orchestration
// ---------------------------------------------------------------------------

describe('registerSchemaRules', () => {
  it('registers schema-shipped rules at the schema layer', () => {
    const reg = createReplacementRegistry()
    const successor: NodeSchema = { ...schemas.NewNode!, replacements: [basicRule] }
    expect(registerSchemaRules(reg, [successor, schemas.RenamedPorts!])).toEqual([])
    expect(reg.rulesFor('OldNode')).toEqual([basicRule])
  })

  it('skips malformed shipped rules, naming the shipping schema', () => {
    const reg = createReplacementRegistry()
    const bad = { from: 'X', cases: [] } as unknown as ReplacementRule
    const successor: NodeSchema = { ...schemas.NewNode!, replacements: [bad, basicRule] }
    const diags = registerSchemaRules(reg, [successor])
    expect(diags).toHaveLength(1)
    expect(diags[0]!.message).toContain("schema 'NewNode'")
    expect(reg.rulesFor('OldNode')).toEqual([basicRule]) // good rule still lands
  })
})

describe('scanReplacements', () => {
  function registryWith(...rules: ReplacementRule[]) {
    const reg = createReplacementRegistry()
    for (const r of rules) expect(reg.register('core', r)).toEqual([])
    return reg
  }

  it('finds every migratable node across graphs; skips others', () => {
    const d = doc(
      {
        g0: graph({
          id: 'g0',
          nodes: { old: node('old', 'OldNode'), keep: node('keep', 'NewNode'), inst: node('inst', '#g1') },
        }),
        g1: graph({ id: 'g1', nodes: { old2: node('old2', 'OldNode') } }),
      },
      'g0',
    )
    const items = scanReplacements(d, registryWith(basicRule), resolve)
    expect(items.map((i) => `${i.graphId}/${i.nodeId}`)).toEqual(['g0/old', 'g1/old2'])
    expect(items.every((i) => i.safe && i.plan !== undefined)).toBe(true)
  })

  it('a warned plan is not safe; an unplannable node reports its failures', () => {
    // Rule with no mappings: wired connections drop -> warnings.
    const lossy: ReplacementRule = { from: 'OldNode', cases: [{ to: 'NewNode' }] }
    const items = scanReplacements(wiredDoc(), registryWith(lossy), resolve)
    expect(items).toHaveLength(1)
    expect(items[0]!.plan).toBeDefined()
    expect(items[0]!.safe).toBe(false)

    const impossible: ReplacementRule = { from: 'OldNode', cases: [{ to: 'Nonexistent' }] }
    const failed = scanReplacements(wiredDoc(), registryWith(impossible), resolve)
    expect(failed[0]!.plan).toBeUndefined()
    expect(failed[0]!.safe).toBe(false)
    expect(failed[0]!.diagnostics.some((x) => x.code === 'replace.target.unknown')).toBe(true)
  })

  it('the first rule that plans wins; later rules are fallbacks only', () => {
    const broken: ReplacementRule = { from: 'OldNode', cases: [{ to: 'Nonexistent' }] }
    const items = scanReplacements(
      doc({ g0: graph({ id: 'g0', nodes: { old: node('old', 'OldNode') } }) }),
      registryWith(broken, basicRule),
      resolve,
    )
    expect(items[0]!.plan?.to).toBe('NewNode')
    expect(items[0]!.rule).toBe(basicRule)
  })

  it('tries later rules after a same-type migration cleanly declines', () => {
    const declined: ReplacementRule = {
      from: 'OldNode',
      migration: { historicalInputs: ['legacy'] },
      cases: [{ to: 'OldNode' }],
    }
    const items = scanReplacements(
      doc({ g0: graph({ id: 'g0', nodes: { old: node('old', 'OldNode') } }) }),
      registryWith(declined, basicRule),
      resolve,
    )
    expect(items).toHaveLength(1)
    expect(items[0]!.plan?.to).toBe('NewNode')
    expect(items[0]!.rule).toBe(basicRule)
  })

  it('replacementInvocation batches several plans into one undo step', () => {
    const d = doc({
      g0: graph({ id: 'g0', nodes: { a: node('a', 'OldNode', { amount: 1 }), b: node('b', 'OldNode', { amount: 2 }) } }),
    })
    const items = scanReplacements(d, registryWith(basicRule), resolve)
    expect(items).toHaveLength(2)
    const inv = replacementInvocation(items)!
    expect(inv.command).toBe('batch')

    const store = new DocumentStore(d, coreCommandRegistry())
    const out = store.dispatch(inv)
    expect(out.ok).toBe(true)
    expect(store.revision).toBe(1)
    expect(store.doc.graphs.g0!.nodes.a!.type).toBe('NewNode')
    expect(store.doc.graphs.g0!.nodes.b!.type).toBe('NewNode')
    expect(store.doc.graphs.g0!.nodes.a!.values).toEqual({ strength: 1, mode: 'bilinear' })
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(d)

    // Single plan dispatches node.replace directly; nothing planned -> undefined.
    expect(replacementInvocation([items[0]!])!.command).toBe('node.replace')
    expect(replacementInvocation([])).toBeUndefined()
  })

  it('does not re-plan helpers created during the same scan/apply pass', () => {
    const createHelper: ReplacementRule = {
      from: 'OldNode',
      cases: [{
        to: 'NewNode',
        nodes: { helper: { type: 'ListJoin' } },
      }],
    }
    const migrateHelper: ReplacementRule = {
      from: 'ListJoin',
      cases: [{ to: 'ListSplit' }],
    }
    const migratePrimary: ReplacementRule = {
      from: 'NewNode',
      cases: [{ to: 'SamePorts' }],
    }
    const d = doc({ g0: graph({ id: 'g0', nodes: { old: node('old', 'OldNode') } }) })
    const items = scanReplacements(
      d,
      registryWith(createHelper, migrateHelper, migratePrimary),
      resolve,
    )
    expect(items).toHaveLength(1)
    expect(items[0]!.nodeId).toBe('old')
    expect(items[0]!.hops.map((hop) => hop.plan.to)).toEqual(['NewNode', 'SamePorts'])

    const store = new DocumentStore(d, coreCommandRegistry())
    expect(store.dispatch(replacementInvocation(items)!).ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes.old!.type).toBe('SamePorts')
    expect(store.doc.graphs.g0!.nodes['old:helper']!.type).toBe('ListJoin')
  })
})

// ---------------------------------------------------------------------------
// Replacement chains (A -> B where B is itself migrated to C)
// ---------------------------------------------------------------------------

describe('replacement chains', () => {
  const chainSchemas: Record<string, NodeSchema> = {
    ChainA: schemaOf('ChainA', [widgetInput('x', 0), output('out')]),
    ChainB: schemaOf('ChainB', [widgetInput('y', 0), output('out')]),
    ChainC: schemaOf('ChainC', [widgetInput('z', 0), output('out')]),
    Consumer: schemaOf('Consumer', [input('in')]),
  }
  const chainResolve = (type: string): NodeSchema | undefined => chainSchemas[type]

  const ruleAB: ReplacementRule = {
    from: 'ChainA',
    cases: [{ to: 'ChainB', inputs: { y: { kind: 'value', input: 'x' } }, outputs: { out: 'out' } }],
  }
  /** Doubles the value on the way through - proves hop 2 reads hop 1's OUTPUT state. */
  const ruleBC: ReplacementRule = {
    from: 'ChainB',
    cases: [
      {
        to: 'ChainC',
        inputs: { z: { kind: 'value', input: 'y', transform: { kind: 'scale', factor: 2 } } },
        outputs: { out: 'out' },
      },
    ],
  }

  function registryWith(...rules: ReplacementRule[]) {
    const reg = createReplacementRegistry()
    for (const r of rules) expect(reg.register('core', r)).toEqual([])
    return reg
  }

  it('plans A -> B -> C sequentially; hop 2 sees hop 1 transformed state', () => {
    const d = doc({ g0: graph({ id: 'g0', nodes: { a: node('a', 'ChainA', { x: 3 }) } }) })
    const items = scanReplacements(d, registryWith(ruleAB, ruleBC), chainResolve)
    expect(items).toHaveLength(1)
    const item = items[0]!
    expect(item.status).toBe('terminal')
    expect(item.terminalType).toBe('ChainC')
    expect(item.hops.map((h) => `${h.plan.from}->${h.plan.to}`)).toEqual(['ChainA->ChainB', 'ChainB->ChainC'])
    // hop 2 was planned against hop 1's result: y=3 existed only there.
    expect(item.hops[1]!.plan.values).toEqual({ z: 6 })
    expect(item.safe).toBe(true)
    // Compat surface: rule/plan are the FIRST hop.
    expect(item.rule).toBe(ruleAB)
    expect(item.plan).toBe(item.hops[0]!.plan)
  })

  it('applies a whole chain as one dispatch, one revision, one undo step', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { a: node('a', 'ChainA', { x: 3 }), dst: node('dst', 'Consumer') },
        links: { l1: link('l1', port('a', 'out'), port('dst', 'in')) },
      }),
    })
    const items = scanReplacements(d, registryWith(ruleAB, ruleBC), chainResolve)
    expect(items[0]!.safe).toBe(true)
    const store = new DocumentStore(d, coreCommandRegistry())
    expect(store.dispatch(replacementInvocation(items)!).ok).toBe(true)
    expect(store.revision).toBe(1)
    expect(store.doc.graphs.g0!.nodes.a!.type).toBe('ChainC')
    expect(store.doc.graphs.g0!.nodes.a!.values).toEqual({ z: 6 })
    // The downstream link survived both output mappings.
    expect(store.doc.graphs.g0!.links.l1!.from).toEqual(port('a', 'out'))
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(d)
  })

  it('a warning on a LATER hop makes the whole chain unsafe but keeps every hop', () => {
    // ruleBC without an output mapping: the wired link drops at hop 2.
    const lossyBC: ReplacementRule = {
      from: 'ChainB',
      cases: [{ to: 'ChainC', inputs: { z: { kind: 'value', input: 'y' } } }],
    }
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { a: node('a', 'ChainA', { x: 1 }), dst: node('dst', 'Consumer') },
        links: { l1: link('l1', port('a', 'out'), port('dst', 'in')) },
      }),
    })
    const items = scanReplacements(d, registryWith(ruleAB, lossyBC), chainResolve)
    const item = items[0]!
    expect(item.status).toBe('terminal')
    expect(item.hops).toHaveLength(2)
    expect(item.hops[0]!.diagnostics).toEqual([])
    expect(item.hops[1]!.diagnostics.length).toBeGreaterThan(0)
    expect(item.safe).toBe(false)
  })

  it('a later hop that cannot plan blocks with the safe prefix intact', () => {
    const brokenBC: ReplacementRule = { from: 'ChainB', cases: [{ to: 'Nonexistent' }] }
    const d = doc({ g0: graph({ id: 'g0', nodes: { a: node('a', 'ChainA', { x: 1 }) } }) })
    const items = scanReplacements(d, registryWith(ruleAB, brokenBC), chainResolve)
    const item = items[0]!
    expect(item.status).toBe('blocked')
    expect(item.hops).toHaveLength(1)
    expect(item.terminalType).toBe('ChainB')
    expect(item.safe).toBe(false)
    expect(item.diagnostics.some((x) => x.code === 'replace.target.unknown')).toBe(true)
    // Explicit review-apply still migrates the safe prefix.
    const store = new DocumentStore(d, coreCommandRegistry())
    expect(store.dispatch(replacementInvocation([item])!).ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes.a!.type).toBe('ChainB')
  })

  it('a cycle stops before re-migrating to a visited type', () => {
    const ruleBA: ReplacementRule = {
      from: 'ChainB',
      cases: [{ to: 'ChainA', inputs: { x: { kind: 'value', input: 'y' } } }],
    }
    const d = doc({ g0: graph({ id: 'g0', nodes: { a: node('a', 'ChainA', { x: 1 }) } }) })
    const items = scanReplacements(d, registryWith(ruleAB, ruleBA), chainResolve)
    const item = items[0]!
    expect(item.status).toBe('cycle')
    expect(item.hops).toHaveLength(1)
    expect(item.terminalType).toBe('ChainB')
    expect(item.safe).toBe(false)
  })

  it('rejects an ordinary same-type rule as a cycle', () => {
    const self: ReplacementRule = {
      from: 'ChainA',
      cases: [{ to: 'ChainA', inputs: { x: { kind: 'copy', input: 'x' } } }],
    }
    const d = doc({ g0: graph({ id: 'g0', nodes: { a: node('a', 'ChainA', { x: 1 }) } }) })
    const item = scanReplacements(d, registryWith(self), chainResolve)[0]!
    expect(item).toMatchObject({ status: 'cycle', hops: [], safe: false, terminalType: 'ChainA' })
    expect(replacementInvocation([item])).toBeUndefined()
  })

  it('blocks a marked same-type migration that remains applicable', () => {
    const repeating: ReplacementRule = {
      from: 'ChainA',
      migration: { historicalInputs: ['x'] },
      cases: [{ to: 'ChainA', inputs: { x: { kind: 'copy', input: 'x' } } }],
    }
    const d = doc({ g0: graph({ id: 'g0', nodes: { a: node('a', 'ChainA', { x: 1 }) } }) })
    const item = scanReplacements(d, registryWith(repeating), chainResolve)[0]!
    expect(item).toMatchObject({ status: 'blocked', hops: [], safe: false, terminalType: 'ChainA' })
    expect(item.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'replace.migration.nonOneShot',
    }))
    expect(replacementInvocation([item])).toBeUndefined()
  })

  it('continues an ordinary replacement chain after a one-shot same-type migration', () => {
    const migration: ReplacementRule = {
      from: 'ChainA',
      migration: { historicalInputs: ['legacy'] },
      cases: [{
        to: 'ChainA',
        when: { kind: 'valuePresent', input: 'legacy' },
        inputs: { x: { kind: 'copy', input: 'legacy' } },
      }, { to: 'ChainA' }],
    }
    const d = doc({ g0: graph({ id: 'g0', nodes: { a: node('a', 'ChainA', { legacy: 4 }) } }) })
    const item = scanReplacements(d, registryWith(migration, ruleAB, ruleBC), chainResolve)[0]!
    expect(item.status).toBe('terminal')
    expect(item.hops.map((hop) => `${hop.plan.from}->${hop.plan.to}`)).toEqual([
      'ChainA->ChainA',
      'ChainA->ChainB',
      'ChainB->ChainC',
    ])
    expect(item.hops[2]!.plan.values).toEqual({ z: 8 })
    expect(item.safe).toBe(true)
  })

  it('composes sibling shared-net sinks through migration and an ordinary hop', () => {
    const migration: ReplacementRule = {
      from: 'ChainA',
      migration: { historicalInputs: ['legacy'] },
      cases: [{ to: 'ChainA', inputs: { x: { kind: 'copy', input: 'legacy' } } }],
    }
    const preservingAB: ReplacementRule = {
      from: 'ChainA',
      cases: [{
        to: 'ChainB',
        inputs: { y: { kind: 'copy', input: 'x' } },
        outputs: { out: 'out' },
      }],
    }
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: {
          src: node('src', 'Producer'),
          a: node('a', 'ChainA', { legacy: 2 }),
          b: node('b', 'ChainA', { legacy: 3 }),
        },
        nets: {
          shared: net('shared', port('src', 'out'), [port('a', 'legacy'), port('b', 'legacy')]),
        },
      }),
    })
    const items = scanReplacements(d, registryWith(migration, preservingAB), chainResolve)
    expect(items).toHaveLength(2)
    expect(items.every((item) => item.safe && item.hops.length === 2)).toBe(true)

    const store = new DocumentStore(d, coreCommandRegistry())
    expect(store.dispatch(replacementInvocation(items)!).ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes.a!.type).toBe('ChainB')
    expect(store.doc.graphs.g0!.nodes.b!.type).toBe('ChainB')
    expect(store.doc.graphs.g0!.nets.shared!.sinks).toEqual([
      port('a', 'y'),
      port('b', 'y'),
    ])
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(d)
  })

  it('keeps surviving lossy sibling sinks in their original shared-net positions', () => {
    const lossySchemas: Record<string, NodeSchema> = {
      LossOld: schemaOf('LossOld', [input('drop'), input('keep')]),
      LossMid: schemaOf('LossMid', [input('keep_mid')]),
      LossNew: schemaOf('LossNew', [input('final')]),
    }
    const lossOldToMid: ReplacementRule = {
      from: 'LossOld',
      cases: [{ to: 'LossMid', inputs: { keep_mid: { kind: 'copy', input: 'keep' } } }],
    }
    const lossMidToNew: ReplacementRule = {
      from: 'LossMid',
      cases: [{ to: 'LossNew', inputs: { final: { kind: 'copy', input: 'keep_mid' } } }],
    }
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: {
          src: node('src', 'Producer'),
          a: node('a', 'LossOld'),
          b: node('b', 'LossOld'),
          u1: node('u1', 'Consumer'),
          u2: node('u2', 'Consumer'),
        },
        nets: {
          shared: net('shared', port('src', 'out'), [
            port('a', 'drop'),
            port('u1', 'in'),
            port('b', 'keep'),
            port('a', 'keep'),
            port('u2', 'in'),
            port('b', 'drop'),
          ]),
        },
      }),
    })
    const items = scanReplacements(
      d,
      registryWith(lossOldToMid, lossMidToNew),
      (type) => lossySchemas[type],
    )
    expect(items).toHaveLength(2)
    expect(items.every((item) => item.hops.length === 2 && !item.safe)).toBe(true)

    const store = new DocumentStore(d, coreCommandRegistry())
    expect(store.dispatch(replacementInvocation(items)!).ok).toBe(true)
    expect(store.doc.graphs.g0!.nets.shared!.sinks).toEqual([
      port('u1', 'in'),
      port('b', 'final'),
      port('a', 'final'),
      port('u2', 'in'),
    ])
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(d)
  })

  it('a runaway chain stops at REPLACEMENT_CHAIN_LIMIT hops', () => {
    const many: Record<string, NodeSchema> = {}
    const rules: ReplacementRule[] = []
    for (let i = 0; i <= REPLACEMENT_CHAIN_LIMIT + 2; i++) {
      many[`T${i}`] = schemaOf(`T${i}`, [widgetInput('v', 0)])
      rules.push({ from: `T${i}`, cases: [{ to: `T${i + 1}`, inputs: { v: { kind: 'value', input: 'v' } } }] })
    }
    many[`T${REPLACEMENT_CHAIN_LIMIT + 3}`] = schemaOf(`T${REPLACEMENT_CHAIN_LIMIT + 3}`, [widgetInput('v', 0)])
    const d = doc({ g0: graph({ id: 'g0', nodes: { n: node('n', 'T0', { v: 1 }) } }) })
    const items = scanReplacements(d, registryWith(...rules), (t) => many[t])
    const item = items[0]!
    expect(item.status).toBe('depth')
    expect(item.hops).toHaveLength(REPLACEMENT_CHAIN_LIMIT)
    expect(item.terminalType).toBe(`T${REPLACEMENT_CHAIN_LIMIT}`)
    expect(item.safe).toBe(false)
  })

  it('mixed scan: single-hop and multi-hop items batch every hop in order', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { a: node('a', 'ChainA', { x: 2 }), b: node('b', 'ChainB', { y: 5 }) },
      }),
    })
    const items = scanReplacements(d, registryWith(ruleAB, ruleBC), chainResolve)
    expect(items.map((i) => i.hops.length)).toEqual([2, 1])
    expect(items.every((i) => i.safe)).toBe(true)
    const store = new DocumentStore(d, coreCommandRegistry())
    expect(store.dispatch(replacementInvocation(items)!).ok).toBe(true)
    expect(store.revision).toBe(1)
    expect(store.doc.graphs.g0!.nodes.a!.type).toBe('ChainC')
    expect(store.doc.graphs.g0!.nodes.a!.values).toEqual({ z: 4 })
    expect(store.doc.graphs.g0!.nodes.b!.type).toBe('ChainC')
    expect(store.doc.graphs.g0!.nodes.b!.values).toEqual({ z: 10 })
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(d)
  })
})
