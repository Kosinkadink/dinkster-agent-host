/**
 * Reset-to-default menu contributions. The contract under test:
 * schema-aware items over a resolver closure - hidden without a resolver or
 * resettable widgets, disabled when nothing is modified, and the action is
 * ONE node.setValues invocation writing the LIVE defaults of exactly the
 * modified widgets (explicit writes, never key deletion).
 */
import { describe, expect, it } from 'vitest'
import type { Json, WorkflowDocument } from '../src/format/document.js'
import { asGraphDefId, asLineageId, asNodeId } from '../src/ids.js'
import {
  createMenuRegistry,
  type MenuActionItem,
  type MenuContext,
  type MenuItem,
  type MenuTarget,
} from '../src/menus/contract.js'
import { resetMenuContributions } from '../src/menus/reset-items.js'
import type { InterfaceItem, NodeSchema, SchemaResolver } from '../src/index.js'

const tunableSchema: NodeSchema = {
  type: 'Tunable',
  displayName: 'Tunable',
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  items: [
    {
      kind: 'input',
      id: 'seed',
      type: { kind: 'concrete', name: 'INT' },
      optional: false,
      widget: { widgetType: 'INT', options: {}, default: 0, controller: 'after_generate' },
    },
    {
      kind: 'input',
      id: 'steps',
      type: { kind: 'concrete', name: 'INT' },
      optional: false,
      widget: { widgetType: 'INT', options: {}, default: 20 },
    },
    { kind: 'section', id: 'adv', displayName: 'Advanced' },
    {
      kind: 'input',
      id: 'cfg',
      type: { kind: 'concrete', name: 'FLOAT' },
      optional: false,
      section: 'adv',
      widget: { widgetType: 'FLOAT', options: {}, default: 7.5 },
    },
    { kind: 'section', id: 'empty', displayName: 'Empty' },
    {
      kind: 'input',
      id: 'img',
      type: { kind: 'concrete', name: 'IMAGE' },
      optional: false,
      section: 'empty',
    },
  ] satisfies InterfaceItem[],
}

const resolver: SchemaResolver = (type) => (type === 'Tunable' ? tunableSchema : undefined)

function docWith(values: Record<string, Json>): WorkflowDocument {
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: asLineageId('lin1'),
    root: asGraphDefId('g0'),
    graphs: {
      g0: {
        id: asGraphDefId('g0'),
        name: 'root',
        nodes: { n1: { id: asNodeId('n1'), type: 'Tunable', values } },
        links: {},
        nets: {},
        reroutes: {},
        nextOrdinal: 100,
      },
    },
    view: { graphs: {} },
  }
}

function ctx(target: MenuTarget, values: Record<string, Json>): MenuContext {
  return {
    doc: docWith(values),
    graphId: 'g0',
    target,
    selection: { nodes: [], links: [], reroutes: [], valueSources: [], selectors: [] },
    worldX: 0,
    worldY: 0,
  }
}

const [widgetReset, sectionReset, nodeReset] = resetMenuContributions(() => resolver)
const widgetTarget = (inputId: string): MenuTarget => ({ kind: 'widget', nodeId: 'n1', inputId })
const sectionTarget = (sectionId: string): MenuTarget => ({
  kind: 'section',
  nodeId: 'n1',
  sectionId,
  collapsed: true,
})

const valuesOf = (item: MenuItem) => {
  const action = (item as MenuActionItem).action
  if (action.kind !== 'command') throw new Error(`expected '${item.id}' to dispatch a command`)
  return action.invocation as { command: string; params: { values: Record<string, Json> } }
}

describe('reset menu contributions', () => {
  it('all targets hide without a resolver', () => {
    const [w, s, n] = resetMenuContributions(() => undefined)
    expect(w!.resolve(ctx(widgetTarget('steps'), { steps: 30 }))).toHaveLength(0)
    expect(s!.resolve(ctx(sectionTarget('adv'), { cfg: 9 }))).toHaveLength(0)
    expect(n!.resolve(ctx({ kind: 'node', nodeId: 'n1' }, { steps: 30 }))).toHaveLength(0)
  })

  it('widget reset writes that widget LIVE default; disabled when unmodified', () => {
    const modified = widgetReset!.resolve(ctx(widgetTarget('steps'), { steps: 30 }))
    expect(modified).toHaveLength(1)
    expect(modified[0]!.disabled).toBeUndefined()
    expect(valuesOf(modified[0]!)).toEqual({
      command: 'node.setValues',
      params: { graphId: 'g0', nodeId: 'n1', values: { steps: 20 } },
    })

    const untouched = widgetReset!.resolve(ctx(widgetTarget('steps'), {}))
    expect(untouched[0]!.disabled).toBe(true)
  })

  it('controller widgets get no reset item (randomized seeds are not "modified")', () => {
    expect(widgetReset!.resolve(ctx(widgetTarget('seed'), { seed: 999 }))).toHaveLength(0)
  })

  it('section reset covers only that section; hidden for widget-less sections', () => {
    const items = sectionReset!.resolve(ctx(sectionTarget('adv'), { cfg: 9, steps: 30 }))
    expect(items).toHaveLength(1)
    // steps is outside the section: not written by a section reset.
    expect(valuesOf(items[0]!).params.values).toEqual({ cfg: 7.5 })

    const unmodified = sectionReset!.resolve(ctx(sectionTarget('adv'), { steps: 30 }))
    expect(unmodified[0]!.disabled).toBe(true)

    expect(sectionReset!.resolve(ctx(sectionTarget('empty'), { cfg: 9 }))).toHaveLength(0)
  })

  it('node reset writes ALL modified widgets in one invocation, skipping controllers', () => {
    const items = nodeReset!.resolve(
      ctx({ kind: 'node', nodeId: 'n1' }, { seed: 999, steps: 30, cfg: 9 }),
    )
    expect(items).toHaveLength(1)
    expect(valuesOf(items[0]!).params.values).toEqual({ steps: 20, cfg: 7.5 })

    const untouched = nodeReset!.resolve(ctx({ kind: 'node', nodeId: 'n1' }, { steps: 20 }))
    expect(untouched[0]!.disabled).toBe(true)
  })

  it('resolves through the shared registry like any extension contribution', () => {
    const registry = createMenuRegistry()
    for (const c of resetMenuContributions(() => resolver)) registry.register(c)
    const groups = registry.resolve(ctx(widgetTarget('steps'), { steps: 30 }))
    expect(groups.flatMap((g) => g.items.map((i) => i.id))).toContain('core.widget.reset')
  })
})
