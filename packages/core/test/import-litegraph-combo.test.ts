import { describe, expect, it } from 'vitest'
import type { Json } from '../src/format/document.js'
import { importLitegraph } from '../src/format/import-litegraph.js'
import { loadDocument } from '../src/format/migrate.js'
import type { NodeSchema } from '../src/schema/model.js'

const schemaFor = (options: readonly Json[], widgetType = 'COMBO'): NodeSchema => ({
  type: 'Choice',
  displayName: 'Choice',
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  items: [
    { kind: 'input', id: 'choice', type: { kind: 'concrete', name: 'COMBO' }, optional: false, widget: { widgetType, options: { options } } },
    { kind: 'input', id: 'tail', type: { kind: 'concrete', name: 'INT' }, optional: false, widget: { widgetType: 'INT', options: {} } },
  ],
})

const cases: { name: string; value: Json; options: Json[]; expected: Json; widgetType?: string }[] = [
  { name: 'declared eight', value: 8, options: ['auto', '8', '10'], expected: '8' },
  { name: 'declared ten', value: 10, options: ['auto', '8', '10'], expected: '10' },
  { name: 'declared negative', value: -8, options: ['-8', '8'], expected: '-8' },
  { name: 'declared fraction', value: 8.5, options: ['8.5'], expected: '8.5' },
  { name: 'unmatched negative', value: -8, options: ['8', '10'], expected: -8 },
  { name: 'unmatched number', value: 12, options: ['8', '10'], expected: 12 },
  { name: 'padded spelling', value: 8, options: ['08'], expected: 8 },
  { name: 'decimal spelling', value: 8, options: ['8.0'], expected: 8 },
  { name: 'presentation label only', value: 8, options: [{ value: 'other', label: '8' }], expected: 8 },
  { name: 'structured choice', value: 8, options: [{ value: '8', label: 'Eight' }], expected: '8' },
  { name: 'legacy tuple', value: 8, options: [['8', 'Eight']], expected: '8' },
  { name: 'numeric choice', value: 8, options: [8, 10], expected: 8 },
  { name: 'numeric and string choices', value: 8, options: [8, '8'], expected: 8 },
  { name: 'structured display label', value: 'euler', options: [{ value: 'dinkster.euler', label: 'euler' }], expected: 'dinkster.euler' },
  { name: 'canonical structured value', value: 'dinkster.euler', options: [{ value: 'dinkster.euler', label: 'euler' }], expected: 'dinkster.euler' },
  { name: 'ambiguous display label', value: 'euler', options: [{ value: 'dinkster.euler', label: 'euler' }, { value: 'other.euler', label: 'euler' }], expected: 'euler' },
  { name: 'canonical value before display label', value: 'normal', options: [{ value: 'dinkster.normal', label: 'normal' }, { value: 'normal', label: 'Normal' }], expected: 'normal' },
  { name: 'legacy tuple display label', value: 'euler', options: [['dinkster.euler', 'euler']], expected: 'euler' },
  { name: 'no static choices', value: 8, options: [], expected: 8 },
  { name: 'boolean stays boolean', value: true, options: ['true'], expected: true },
  { name: 'string stays string', value: '08', options: ['8'], expected: '08' },
  { name: 'non-COMBO stays numeric', value: 8, options: ['8'], widgetType: 'INT', expected: 8 },
]

for (const keyed of [false, true]) {
  describe(`${keyed ? 'keyed' : 'positional'} legacy static COMBO normalization`, () => {
    it.each(cases)('$name', ({ value, options, expected, widgetType }) => {
      const schema = schemaFor(options, widgetType)
      const imported = importLitegraph({
        version: 0.4,
        nodes: [{ id: 1, type: 'Choice', widgets_values: keyed ? { choice: value, tail: 17 } : [value, 17] }],
        links: [],
      }, () => schema)
      expect(imported.diagnostics).toEqual([])
      expect(imported.document!.graphs['g0']!.nodes['n1']!.values).toEqual({ choice: expected, tail: 17 })
      const reopened = loadDocument(JSON.parse(JSON.stringify(imported.document)))
      expect(reopened.diagnostics).toEqual([])
      expect(reopened.document).toEqual(imported.document)
    })

    it.each([NaN, Infinity, -Infinity])('rejects non-finite input %s before widget decoding', (value) => {
      const imported = importLitegraph({
        version: 0.4,
        nodes: [{ id: 1, type: 'Choice', widgets_values: keyed ? { choice: value } : [value] }],
        links: [],
      }, () => schemaFor(['NaN', 'Infinity', '-Infinity']))
      expect(imported.document).toBeUndefined()
      expect(imported.diagnostics.some((item) => item.severity === 'error')).toBe(true)
    })
  })
}
