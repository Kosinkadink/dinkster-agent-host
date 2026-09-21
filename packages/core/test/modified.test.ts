/**
 * Derived modified-from-default state. The contract under test:
 * resettableWidgetsOf is a pure function of (elaborated interface, values) -
 * eligibility rules keep the signal honest (no default / controller /
 * selector / ghost / forceInput excluded), equality is canonical-JSON deep,
 * a missing values key means "at the default", and defaults are always the
 * LIVE schema's (an old-default stored value reads as modified).
 */
import { describe, expect, it } from 'vitest'
import { elaborateInterface } from '../src/schema/elaborate.js'
import { resettableWidgetsOf } from '../src/schema/modified.js'
import type { InputSpec, InterfaceItem, NodeSchema, WidgetSpec } from '../src/schema/model.js'
import type { Json } from '../src/format/document.js'

const schemaOf = (items: InterfaceItem[]): NodeSchema => ({
  type: 'Test',
  displayName: 'Test',
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  items,
})

const widgetInput = (
  id: string,
  widget: Partial<WidgetSpec> & { widgetType: string },
  extra: Partial<InputSpec> = {},
): InputSpec => ({
  kind: 'input',
  id,
  type: { kind: 'concrete', name: widget.widgetType },
  optional: false,
  widget: { options: {}, ...widget },
  ...extra,
})

const resettable = (items: InterfaceItem[], values: Record<string, Json>, dynamic?: Record<string, unknown>) =>
  resettableWidgetsOf(
    elaborateInterface(schemaOf(items), { values, ...(dynamic ? { dynamic } : {}) } as never),
    values,
  )

describe('resettableWidgetsOf eligibility', () => {
  it('includes widget-backed inputs with a default; excludes sockets and no-default widgets', () => {
    const rs = resettable(
      [
        widgetInput('steps', { widgetType: 'INT', default: 20 }),
        widgetInput('label', { widgetType: 'STRING' }), // no default
        { kind: 'input', id: 'img', type: { kind: 'concrete', name: 'IMAGE' }, optional: false },
      ],
      {},
    )
    expect(rs.map((r) => r.valueKey)).toEqual(['steps'])
    expect(rs[0]!.defaultValue).toBe(20)
  })

  it('excludes controller-slotted widgets (seed randomization is not "modified")', () => {
    const rs = resettable(
      [
        widgetInput('seed', { widgetType: 'INT', default: 0, controller: 'after_generate' }),
        widgetInput('steps', { widgetType: 'INT', default: 20 }),
      ],
      { seed: 12345, steps: 20 },
    )
    expect(rs.map((r) => r.valueKey)).toEqual(['steps'])
  })

  it('excludes forceInput widgets (rendered as sockets, no widget value UI)', () => {
    const rs = resettable(
      [widgetInput('steps', { widgetType: 'INT', default: 20 }, { forceInput: true })],
      {},
    )
    expect(rs).toHaveLength(0)
  })

  it('dynamicCombo: selector row excluded, branch widgets with defaults included', () => {
    const items: InterfaceItem[] = [
      {
        kind: 'input',
        id: 'mode',
        type: { kind: 'concrete', name: 'COMBO' },
        optional: false,
        dynamic: {
          kind: 'dynamicCombo',
          options: [
            { key: 'a', inputs: [widgetInput('strength', { widgetType: 'FLOAT', default: 1 })] },
            { key: 'b', inputs: [] },
          ],
        },
      },
    ]
    const rs = resettable(items, {})
    // Exactly one entry: the branch widget, never the selector.
    expect(rs).toHaveLength(1)
    expect(rs[0]!.item.origin.kind).not.toBe('selector')
    expect(rs[0]!.defaultValue).toBe(1)
  })

  it('autogrow: materialized member widgets included, trailing ghost excluded', () => {
    const family: InputSpec = {
      kind: 'input',
      id: 'items',
      type: { kind: 'wildcard' },
      optional: false,
      dynamic: {
        kind: 'autogrow',
        template: [widgetInput('item', { widgetType: 'INT', default: 5 })],
        naming: { kind: 'prefix', prefix: 'item', min: 0, max: 4 },
      },
    }
    const rs = resettable([family], {}, { items: { members: ['m0'] } })
    // One materialized member; the ghost affordance contributes nothing.
    expect(rs).toHaveLength(1)
    expect(rs[0]!.defaultValue).toBe(5)
  })
})

describe('resettableWidgetsOf modified semantics', () => {
  const steps = widgetInput('steps', { widgetType: 'INT', default: 20 })

  it('missing key = at the default = not modified', () => {
    expect(resettable([steps], {})[0]!.modified).toBe(false)
  })

  it('stored value equal to the default is not modified; different is', () => {
    expect(resettable([steps], { steps: 20 })[0]!.modified).toBe(false)
    expect(resettable([steps], { steps: 21 })[0]!.modified).toBe(true)
  })

  it('deep equality is canonical: object key order does not matter', () => {
    const w = widgetInput('box', { widgetType: 'BBOX', default: { x: 1, y: 2 } as unknown as Json })
    expect(resettable([w], { box: { y: 2, x: 1 } })[0]!.modified).toBe(false)
    expect(resettable([w], { box: { y: 3, x: 1 } })[0]!.modified).toBe(true)
  })

  it('list defaults compare element-wise', () => {
    const w = widgetInput('pts', { widgetType: 'CURVE', default: [0, 1] as unknown as Json })
    expect(resettable([w], { pts: [0, 1] })[0]!.modified).toBe(false)
    expect(resettable([w], { pts: [1, 0] })[0]!.modified).toBe(true)
  })

  it('defaults are LIVE: a value equal to an old default reads modified under a new one', () => {
    const stored = { steps: 20 } // saved when the default was 20
    const oldSchema = [widgetInput('steps', { widgetType: 'INT', default: 20 })]
    const newSchema = [widgetInput('steps', { widgetType: 'INT', default: 25 })]
    expect(resettable(oldSchema, stored)[0]!.modified).toBe(false)
    const underNew = resettable(newSchema, stored)[0]!
    expect(underNew.modified).toBe(true)
    expect(underNew.defaultValue).toBe(25) // reset writes the CURRENT default
  })
})
