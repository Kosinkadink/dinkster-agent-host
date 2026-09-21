import { describe, expect, it } from 'vitest'
import { inputsOf } from '../src/schema/model.js'
import {
  DINKSTER_ADVERTISED_WIRE_VERSIONS,
  DINKSTER_SCHEMA_WIRE_VERSION,
  parseDinksterNodes,
} from '../src/schema/dinkster-wire.js'

const entry = (widget: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
  role: 'input',
  id: 'choice',
  type: widget.type === 'MULTI_COMBO'
    ? { kind: 'list', element: { kind: 'concrete', types: ['core.combo'] } }
    : { kind: 'concrete', types: ['core.combo'] },
  required: true,
  widget,
  ...overrides,
})

const decode = (wire: number, widget: Record<string, unknown>, overrides: Record<string, unknown> = {}) => parseDinksterNodes({
  schemaVersion: wire,
  nodes: {
    Choice: {
      schemaVersion: wire,
      interface: [entry(widget, overrides)],
    },
  },
})

describe.each([23, 39, 40, 41])('schema wire %s structured combo choices', (wire) => {
  it('advertises wire 23', () => {
    expect(DINKSTER_SCHEMA_WIRE_VERSION).toBe(44)
    expect(DINKSTER_ADVERTISED_WIRE_VERSIONS.at(-1)).toBe(44)
  })

  it.each(['COMBO', 'MULTI_COMBO'])('decodes %s values separately from presentation metadata', (type) => {
    const result = decode(wire, {
      type,
      options: [
        'dinkster.plain',
        { value: 'dinkster.euler', label: 'euler' },
        { value: 'dinkster.uni_pc', label: 'UniPC', info: 'Predictor-corrector sampler', folder: 'Solvers/ODE' },
      ],
    }, type === 'MULTI_COMBO' ? { default: ['dinkster.euler'] } : { default: 'dinkster.euler' })
    expect(result.diagnostics).toEqual([])
    const input = inputsOf(result.schemas.get('Choice')!)[0]!
    expect(input.widget?.options['options']).toEqual([
      'dinkster.plain',
      { value: 'dinkster.euler', label: 'euler' },
      { value: 'dinkster.uni_pc', label: 'UniPC', info: 'Predictor-corrector sampler', folder: 'Solvers/ODE' },
    ])
    expect(input.widget?.default).toEqual(type === 'MULTI_COMBO' ? ['dinkster.euler'] : 'dinkster.euler')
  })

  it.each([
    ['unknown field', { value: 'dinkster.euler', tooltip: 'Euler' }],
    ['blank value', { value: '' }],
    ['blank label', { value: 'dinkster.euler', label: '' }],
    ['blank info', { value: 'dinkster.euler', info: '' }],
    ['blank folder', { value: 'dinkster.euler', folder: '' }],
    ['absolute folder', { value: 'dinkster.euler', folder: '/Solvers' }],
    ['trailing slash', { value: 'dinkster.euler', folder: 'Solvers/' }],
    ['empty segment', { value: 'dinkster.euler', folder: 'Solvers//ODE' }],
    ['current segment', { value: 'dinkster.euler', folder: 'Solvers/./ODE' }],
    ['parent segment', { value: 'dinkster.euler', folder: 'Solvers/../ODE' }],
    ['backslash', { value: 'dinkster.euler', folder: 'Solvers\\ODE' }],
  ])('rejects malformed structured choice: %s', (_name, option) => {
    const result = decode(wire, { type: 'COMBO', options: [option] })
    expect(result.schemas.size).toBe(0)
    expect(result.diagnostics).toEqual([expect.objectContaining({ severity: 'error', code: 'schema.parse.threw' })])
  })

  it.each(['COMBO', 'MULTI_COMBO'])('keeps wire 22 frozen against structured %s choices', (type) => {
    const result = decode(22, { type, options: [{ value: 'dinkster.euler', label: 'euler' }] })
    expect(result.schemas.size).toBe(0)
    expect(result.diagnostics).toEqual([expect.objectContaining({ severity: 'error', code: 'schema.parse.threw' })])
  })
})
