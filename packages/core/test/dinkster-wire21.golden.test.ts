import { describe, expect, it } from 'vitest'
import {
  DINKSTER_ACCEPTED_WIRE_VERSIONS,
  DINKSTER_SCHEMA_WIRE_VERSION,
  parseDinksterNodes,
  type DinksterNodesPayload,
} from '../src/schema/dinkster-wire.js'
import { effectiveWidgetDefault } from '../src/schema/widget-defaults.js'
import { inputsOf } from '../src/schema/model.js'

const multiCombo = (overrides: Record<string, unknown> = {}) => ({
  role: 'input',
  id: 'providers',
  required: true,
  type: { kind: 'list', element: { kind: 'concrete', types: ['core.combo'] } },
  default: ['beta', 'alpha', 'beta'],
  widget: {
    type: 'MULTI_COMBO',
    options: ['beta', 'alpha', 'beta'],
    remote: {
      route: '/api/choices/fixture.providers',
      refreshButton: true,
      controlAfterRefresh: 'last',
      timeoutMs: 4096,
      maxRetries: 2,
      refreshMs: 0,
    },
    placeholder: 'Select providers',
    chip: false,
    ...overrides,
  },
})

const catalog = (wire: number, entry: Record<string, unknown>): DinksterNodesPayload => ({
  schemaVersion: wire,
  nodes: {
    MultiCombo: {
      schemaVersion: wire,
      signature: 'backend-authored-signature',
      interface: [entry],
    },
  },
})

describe.each([21, 39, 40, 41])('schema wire %s MULTI_COMBO', (wire) => {
  it('advertises wire 21 and decodes the exact list-valued descriptor', () => {
    expect(DINKSTER_SCHEMA_WIRE_VERSION).toBe(44)
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS.at(-1)).toBe(44)
    const result = parseDinksterNodes(catalog(wire, multiCombo()))
    expect(result.diagnostics).toEqual([])
    const input = inputsOf(result.schemas.get('MultiCombo')!)[0]!
    expect(input.type).toEqual({ kind: 'list', element: { kind: 'concrete', name: 'core.combo' } })
    expect(input.widget).toEqual({
      widgetType: 'MULTI_COMBO',
      options: { options: ['beta', 'alpha', 'beta'], placeholder: 'Select providers', chip: false },
      remote: {
        route: '/api/choices/fixture.providers', refreshButton: true,
        controlAfterRefresh: 'last', timeoutMs: 4096, maxRetries: 2, refreshMs: 0,
      },
      default: ['beta', 'alpha', 'beta'],
    })
    expect(effectiveWidgetDefault(input.widget!)).toEqual(['beta', 'alpha', 'beta'])
  })

  it('uses intrinsic [] when the default is absent and preserves explicit empty defaults', () => {
    const { default: _default, ...absent } = multiCombo()
    const absentSpec = inputsOf(parseDinksterNodes(catalog(wire, absent)).schemas.get('MultiCombo')!)[0]!.widget!
    expect(effectiveWidgetDefault(absentSpec)).toEqual([])

    const empty = { ...multiCombo(), default: [] }
    const emptySpec = inputsOf(parseDinksterNodes(catalog(wire, empty)).schemas.get('MultiCombo')!)[0]!.widget!
    expect(effectiveWidgetDefault(emptySpec)).toEqual([])
  })

  it.each([
    ['scalar socket', { ...multiCombo(), type: { kind: 'concrete', types: ['core.combo'] } }],
    ['generic list socket', { ...multiCombo(), type: { kind: 'list', element: { kind: 'wildcard' } } }],
    ['scalar default', { ...multiCombo(), default: 'beta' }],
    ['numeric default member', { ...multiCombo(), default: ['beta', 1] }],
    ['empty source', multiCombo({ options: [], remote: undefined })],
    ['unknown descriptor key', multiCombo({ unknown: true })],
  ])('rejects schema-significant malformation: %s', (_name, entry) => {
    const result = parseDinksterNodes(catalog(wire, entry))
    expect(result.schemas.size).toBe(0)
    expect(result.diagnostics).toEqual([expect.objectContaining({ severity: 'error', code: 'schema.parse.threw' })])
  })

  it('drops malformed presentation fields and remote policy fields with scoped warnings', () => {
    const result = parseDinksterNodes(catalog(wire, multiCombo({
      placeholder: 3,
      chip: 'yes',
      remote: {
        route: '/api/choices/fixture.providers', refreshButton: true,
        controlAfterRefresh: 'middle', timeoutMs: 0, maxRetries: 6, refreshMs: -1,
      },
    })))
    expect(result.schemas.size).toBe(1)
    expect(result.diagnostics.length).toBe(6)
    expect(result.diagnostics.every((diagnostic) => diagnostic.severity === 'warning')).toBe(true)
    const widget = inputsOf(result.schemas.get('MultiCombo')!)[0]!.widget!
    expect(widget.options).toEqual({ options: ['beta', 'alpha', 'beta'] })
    expect(widget.remote).toEqual({ route: '/api/choices/fixture.providers', refreshButton: true })
  })

  it.each(DINKSTER_ACCEPTED_WIRE_VERSIONS.filter((wire) => wire < 21))('keeps wire %s frozen and rejects MULTI_COMBO loudly', (wire) => {
    const result = parseDinksterNodes(catalog(wire, multiCombo()))
    expect(result.schemas.size).toBe(0)
    expect(result.diagnostics).toEqual([expect.objectContaining({
      severity: 'error', code: 'schema.parse.threw', message: expect.stringContaining('MULTI_COMBO requires schema wire 21'),
    })])
  })

  it('retains exact old-wire per-schema skip classifications as diagnostics', () => {
    const result = parseDinksterNodes({
      schemaVersion: 20,
      nodes: {},
      schemaSkips: [{
        nodeType: 'MultiCombo',
        code: 'schema-wire-required',
        requiredWire: 21,
        reason: 'MULTI_COMBO widget requires schema wire 21',
      }],
    })
    expect(result.diagnostics).toEqual([expect.objectContaining({
      severity: 'warning',
      code: 'schema.dinkster.schemaWireRequired',
      data: {
        nodeType: 'MultiCombo', code: 'schema-wire-required', requiredWire: 21,
        reason: 'MULTI_COMBO widget requires schema wire 21',
      },
    })])

    const malformed = parseDinksterNodes({ schemaVersion: 20, nodes: {}, schemaSkips: [{
      nodeType: 'MultiCombo', code: 'schema-wire-required', requiredWire: 21,
      reason: 'MULTI_COMBO widget requires schema wire 21', extra: true,
    }] })
    expect(malformed.diagnostics).toEqual([expect.objectContaining({ code: 'schema.dinkster.badSchemaSkip' })])
  })
})
