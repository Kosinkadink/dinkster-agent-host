import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DINKSTER_ACCEPTED_WIRE_VERSIONS,
  DINKSTER_SCHEMA_WIRE_VERSION,
  parseDinksterNodes,
  type DinksterNodesPayload,
} from '../src/schema/dinkster-wire.js'
import { inputsOf } from '../src/schema/model.js'

const fixture = (name: string): Buffer => readFileSync(
  new URL(`../fixtures/replacements/${name}.json`, import.meta.url),
)

const input = (remote: Record<string, unknown>) => ({
  role: 'input', id: 'choice', required: true,
  type: { kind: 'concrete', types: ['core.combo'] },
  widget: { type: 'COMBO', remote },
})

const catalog = (wire: number, remote: Record<string, unknown>): DinksterNodesPayload => ({
  schemaVersion: wire,
  nodes: {
    PolicyCombo: {
      schemaVersion: wire,
      signature: 'backend-authored-signature',
      interface: [input(remote)],
    },
  },
})

describe('schema wire 20 remote COMBO policy', () => {
  it('pins the exact backend a479dfee wire 21 replacement goldens', () => {
    expect(Object.fromEntries(['vocabulary', 'chain', 'combo'].map((name) => [
      name,
      createHash('sha256').update(fixture(name)).digest('hex'),
    ]))).toEqual({
      vocabulary: 'c2b6a8916c19e8b5f23a8cda03841daedcc4ac8e54749af59cf23981af1c36f7',
      chain: 'efb460bff6efa2d5aac64c7212002377f147419fe73734167b714fcb06b07e14',
      combo: 'aa8a1f15a9e9f90d779bdaecaf48882850e6f5514dcec1de312ad93088f2f24f',
    })
  })

  it('advertises wire 21 while retaining wire 20 policy decoding', () => {
    expect(DINKSTER_SCHEMA_WIRE_VERSION).toBe(44)
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS.at(-1)).toBe(44)
    const result = parseDinksterNodes(catalog(20, {
      route: '/api/choices/models', refreshButton: true,
      controlAfterRefresh: 'last', timeoutMs: 1234, maxRetries: 4, refreshMs: 5000,
    }))
    expect(result.diagnostics).toEqual([])
    expect(inputsOf(result.schemas.get('PolicyCombo')!)[0]!.widget?.remote).toEqual({
      route: '/api/choices/models', refreshButton: true,
      controlAfterRefresh: 'last', timeoutMs: 1234, maxRetries: 4, refreshMs: 5000,
    })
  })

  it.each([
    ['controlAfterRefresh', 'middle'],
    ['timeoutMs', true],
    ['timeoutMs', 0],
    ['timeoutMs', 1.5],
    ['maxRetries', 6],
    ['refreshMs', -1],
  ])('drops malformed policy %s alone with a scoped warning', (field, value) => {
    const result = parseDinksterNodes(catalog(20, {
      route: '/api/choices/models', refreshButton: true, maxRetries: 2, [field]: value,
    }))
    expect(result.schemas.size).toBe(1)
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'warning', code: 'schema.dinkster.badComboRemotePolicy',
    }))
    const remote = inputsOf(result.schemas.get('PolicyCombo')!)[0]!.widget?.remote
    expect(remote).toMatchObject({ route: '/api/choices/models', refreshButton: true })
    if (field !== 'maxRetries') expect(remote).toHaveProperty('maxRetries', 2)
    expect(remote).not.toHaveProperty(field)
  })

  it('drops controlAfterRefresh without refreshButton but preserves the remote route', () => {
    const result = parseDinksterNodes(catalog(20, {
      route: '/api/choices/models', controlAfterRefresh: 'first', maxRetries: 1,
    }))
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'warning', code: 'schema.dinkster.badComboRemotePolicy',
    }))
    expect(inputsOf(result.schemas.get('PolicyCombo')!)[0]!.widget?.remote).toEqual({
      route: '/api/choices/models', maxRetries: 1,
    })
  })

  it('keeps wire 19 frozen and rejects wire20 policy keys as unknown fields', () => {
    const result = parseDinksterNodes(catalog(19, {
      route: '/api/choices/models', refreshButton: true, timeoutMs: 1000,
    }))
    expect(result.schemas.size).toBe(0)
    expect(result.diagnostics).toEqual([expect.objectContaining({
      severity: 'error', code: 'schema.parse.threw',
    })])
  })
})
