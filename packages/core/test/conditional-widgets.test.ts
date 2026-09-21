import { describe, expect, it } from 'vitest'
import { hiddenConditionalWidgets } from '../src/schema/conditional-widgets.js'
import type { InputSpec, NodeSchema } from '../src/schema/model.js'

const widget = (id: string, widgetType = 'STRING', defaultValue?: unknown): InputSpec => ({ kind: 'input', id, type: { kind: 'concrete', name: 'core.string' }, optional: false, widget: { widgetType, options: {}, ...(defaultValue === undefined ? {} : { default: defaultValue }) } })
const schema: NodeSchema = { type: 'Generic', displayName: 'Generic', category: 'test', source: 'v3', isOutputNode: false, items: [widget('mode', 'STRING', 'basic'), widget('a'), widget('b')], widgetGroups: [{ input: 'mode', values: ['advanced'], members: ['a'] }, { input: 'mode', values: ['expert'], members: ['a', 'b'] }] }

describe('conditional widget visibility', () => {
  it('uses stored values before defaults and combines groups with OR', () => {
    expect([...hiddenConditionalWidgets(schema, { values: {} })].sort()).toEqual(['a', 'b'])
    expect([...hiddenConditionalWidgets(schema, { values: { mode: 'advanced' } })]).toEqual(['b'])
    expect([...hiddenConditionalWidgets(schema, { values: { mode: 'expert' } })]).toEqual([])
  })

  it('fails open for connected, missing, or malformed drivers', () => {
    expect([...hiddenConditionalWidgets(schema, { values: { mode: {} } })]).toEqual([])
    expect([...hiddenConditionalWidgets(schema, { values: { mode: 2 ** 53 } })]).toEqual([])
    expect([...hiddenConditionalWidgets(schema, { values: {} }, (direction, id) => direction === 'in' && id === 'mode')]).toEqual([])
    expect([...hiddenConditionalWidgets({ ...schema, items: schema.items.slice(1) }, { values: {} })]).toEqual([])
  })

  it('preserves connected members and uses exact scalar matching', () => {
    const numeric = { ...schema, widgetGroups: [{ input: 'mode', values: [1], members: ['a', 'b'] }] }
    expect([...hiddenConditionalWidgets(numeric, { values: { mode: '1' } }, (_, id) => id === 'a')]).toEqual(['b'])
    expect([...hiddenConditionalWidgets(numeric, { values: { mode: 1 } })]).toEqual([])
  })

  it('requires every condition within a group and fails open for unknown requirements', () => {
    const conjunctive: NodeSchema = {
      ...schema,
      items: [...schema.items, widget('compatibility', 'STRING', 'native')],
      widgetGroups: [{
        input: 'mode',
        values: ['advanced'],
        members: ['a'],
        requires: [{ input: 'compatibility', values: ['native'] }],
      }],
    }
    expect([...hiddenConditionalWidgets(conjunctive, { values: { mode: 'advanced' } })]).toEqual([])
    expect([...hiddenConditionalWidgets(conjunctive, { values: { mode: 'advanced', compatibility: 'legacy' } })]).toEqual(['a'])
    expect([...hiddenConditionalWidgets(conjunctive, { values: { mode: 'basic', compatibility: {} } })]).toEqual([])
    expect([...hiddenConditionalWidgets(conjunctive, { values: { mode: 'basic', compatibility: 'legacy' } }, (direction, id) => direction === 'in' && id === 'compatibility')]).toEqual([])
  })
})
