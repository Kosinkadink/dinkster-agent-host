import { describe, expect, it } from 'vitest'
import {
  DINKSTER_ACCEPTED_WIRE_VERSIONS,
  DINKSTER_ADVERTISED_WIRE_VERSIONS,
  DINKSTER_SCHEMA_WIRE_VERSION,
  parseDinksterNodes,
  parseDinksterSchemaWire33,
} from '../src/schema/dinkster-wire.js'
import { inputsOf } from '../src/schema/model.js'

const input = (socket: 'core.int' | 'core.float', widget: Record<string, unknown>, defaultValue: number | string = 0) => ({
  role: 'input',
  id: 'value',
  type: { kind: 'concrete', types: [socket] },
  required: true,
  default: defaultValue,
  widget,
})

const decode = (wire: number, socket: 'core.int' | 'core.float', widget: Record<string, unknown>, defaultValue: number | string = 0) => parseDinksterNodes({
  schemaVersion: wire,
  nodes: {
    ExactInteger: {
      schemaVersion: wire,
      interface: [input(socket, widget, defaultValue)],
    },
  },
})

describe.each([33, 39, 40, 41])('schema wire %s exact integer constraints', (wire) => {
  it('pins the current, accepted, and advertised versions', () => {
    expect(DINKSTER_SCHEMA_WIRE_VERSION).toBe(44)
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS.at(-1)).toBe(44)
    expect(DINKSTER_ADVERTISED_WIRE_VERSIONS.at(-1)).toBe(44)
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS).toContain(32)
    expect(DINKSTER_ADVERTISED_WIRE_VERSIONS).toContain(32)
  })

  it('decodes uint64 constraints and defaults as exact decimal strings', () => {
    const result = decode(wire, 'core.int', {
      type: 'NUMBER',
      min: '-9223372036854775808',
      max: '18446744073709551615',
      step: '9007199254740992',
    }, '18446744073709551615')

    expect(result.diagnostics).toEqual([])
    expect(inputsOf(result.schemas.get('ExactInteger')!)[0]!.widget).toEqual({
      widgetType: 'INT',
      options: {
        min: '-9223372036854775808',
        max: '18446744073709551615',
        step: '9007199254740992',
      },
      default: '18446744073709551615',
    })
  })

  it('keeps safe integer constraints as JSON numbers', () => {
    const result = decode(wire, 'core.int', { type: 'NUMBER', min: 0, max: Number.MAX_SAFE_INTEGER, step: 1 })
    expect(result.diagnostics).toEqual([])
    expect(inputsOf(result.schemas.get('ExactInteger')!)[0]!.widget?.options).toEqual({
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      step: 1,
    })
  })

  it.each([
    ['leading zero', '018446744073709551615'],
    ['plus sign', '+18446744073709551615'],
    ['safe value as a string', '42'],
    ['below signed range', '-9223372036854775809'],
    ['above unsigned range', '18446744073709551616'],
  ])('rejects a %s', (_name, max) => {
    const result = decode(wire, 'core.int', { type: 'NUMBER', max })
    expect(result.schemas.size).toBe(0)
    expect(result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(true)
  })

  it('rejects unsafe decimal strings on float sockets', () => {
    const result = decode(wire, 'core.float', { type: 'NUMBER', max: '18446744073709551615' })
    expect(result.schemas.size).toBe(0)
    expect(result.diagnostics.some((diagnostic) => diagnostic.message.includes('decimal integer constraints require core.int'))).toBe(true)
  })

  it('keeps wire 32 frozen by rejecting decimal integer constraints', () => {
    const result = decode(32, 'core.int', { type: 'NUMBER', max: '18446744073709551615' })
    expect(result.schemas.size).toBe(0)
    expect(result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(true)
  })

  it('exports the direct wire-33 decoder', () => {
    const result = parseDinksterSchemaWire33('ExactInteger', {
      schemaVersion: 33,
      interface: [input('core.int', { type: 'NUMBER', max: '18446744073709551615' })],
    })
    expect(result.diagnostics).toEqual([])
    expect(result.schema).toBeDefined()
  })
})
