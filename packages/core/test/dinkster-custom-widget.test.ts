import { describe, expect, it } from 'vitest'
import { inputsOf } from '../src/schema/model.js'
import { parseDinksterNodes } from '../src/schema/dinkster-wire.js'

const catalog = (widget: unknown) => ({
  schemaVersion: 1,
  nodes: {
    'pack.custom': {
      schemaVersion: 1,
      displayName: 'Pack Custom',
      interface: [{
        role: 'input',
        id: 'level',
        type: { kind: 'concrete', types: ['pack.level'] },
        required: false,
        default: { amount: 3 },
        widget,
      }],
    },
  },
})

describe('pack-declared custom widget descriptors', () => {
  it('preserves the custom type and JSON parameters for widgetKind lookup', () => {
    const result = parseDinksterNodes(catalog({
      type: 'pack.level-dial',
      minimum: 1,
      labels: ['quiet', 'loud'],
      appearance: { color: 'blue' },
    }))

    expect(result.diagnostics).toEqual([])
    expect(inputsOf(result.schemas.get('pack.custom')!)[0]!.widget).toEqual({
      widgetType: 'pack.level-dial',
      options: {
        minimum: 1,
        labels: ['quiet', 'loud'],
        appearance: { color: 'blue' },
      },
      default: { amount: 3 },
    })
  })

  it('rejects a custom descriptor without a non-empty type', () => {
    for (const type of ['', 7, null]) {
      const result = parseDinksterNodes(catalog({ type, minimum: 1 }))
      expect(result.schemas.size).toBe(0)
      expect(result.diagnostics[0]?.message).toContain('type must be a non-empty string')
    }
  })
})
