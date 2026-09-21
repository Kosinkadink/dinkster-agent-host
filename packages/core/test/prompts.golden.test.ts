/**
 * Prompt golden fixtures: each fixtures/prompts/<name>.expected.json is the
 * compile output contract for fixtures/workflows/<name>.json (see the README
 * there; both prompts were validated against a real server). These tests
 * keep the PAIRS coherent:
 *
 * - the workflow side loads clean
 * - the prompt side is a well-formed API prompt with resolvable link refs
 * - every class_type exists in the real object_info fixture
 * - runtime ids follow the occurrence-key contract
 * - the subgraph pair's boundary derivation works against REAL parsed
 *   schemas, and the promoted value override is consistent across the pair
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Prompt } from '../src/compile/artifact.js'
import type { GraphDef, JsonObject } from '../src/format/document.js'
import { loadDocument, detectFormat } from '../src/format/migrate.js'
import { parseObjectInfo, type ObjectInfoEntry } from '../src/schema/object-info.js'
import { deriveBoundarySchema } from '../src/schema/derive-boundary.js'
import { inputsOf, outputsOf } from '../src/schema/model.js'
import { occurrenceKey, asNodeId } from '../src/ids.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (rel: string): unknown =>
  JSON.parse(readFileSync(join(root, rel), 'utf8'))

const PAIRS = ['exec-basic', 'exec-subgraph'] as const

const objectInfo = readJson('fixtures/object_info.json') as Record<string, ObjectInfoEntry>
const { schemas } = parseObjectInfo(objectInfo)

describe.each(PAIRS)('prompt pair %s', (name) => {
  const workflow = readJson(`fixtures/workflows/${name}.json`)
  const prompt = readJson(`fixtures/prompts/${name}.expected.json`) as Prompt

  it('workflow side loads without error diagnostics', () => {
    const result = loadDocument(workflow)
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(result.document).toBeDefined()
  })

  it('prompt side is a well-formed API prompt', () => {
    expect(detectFormat(prompt)).toBe('comfy-api-prompt')
  })

  it('every link ref resolves to a prompt node and a real output index', () => {
    for (const [id, node] of Object.entries(prompt)) {
      for (const [inputId, value] of Object.entries(node.inputs)) {
        if (Array.isArray(value)) {
          const [srcId, outIndex] = value as unknown as readonly [string, number]
          expect(prompt[srcId], `${id}.${inputId} -> ${srcId}`).toBeDefined()
          const srcSchema = schemas.get(prompt[srcId]!.class_type)!
          expect(outIndex).toBeLessThan(outputsOf(srcSchema).length)
        }
      }
    }
  })

  it('every class_type exists in the real object_info fixture', () => {
    for (const node of Object.values(prompt)) {
      expect(schemas.has(node.class_type), node.class_type).toBe(true)
    }
  })

  it('every widget value key is a schema input id', () => {
    for (const node of Object.values(prompt)) {
      const schema = schemas.get(node.class_type)!
      const inputIds = new Set(inputsOf(schema).map((i) => i.id))
      for (const key of Object.keys(node.inputs)) {
        expect(inputIds.has(key), `${node.class_type}.${key}`).toBe(true)
      }
    }
  })
})

describe('exec-subgraph pair pins the flattening contract', () => {
  const doc = loadDocument(readJson('fixtures/workflows/exec-subgraph.json')).document!
  const prompt = readJson('fixtures/prompts/exec-subgraph.expected.json') as Prompt

  it('runtime ids are occurrence keys', () => {
    const innerKey = occurrenceKey({ instancePath: [asNodeId('n0')], node: asNodeId('n0') })
    const rootKey = occurrenceKey({ instancePath: [], node: asNodeId('n1') })
    expect(Object.keys(prompt).sort()).toEqual([innerKey, rootKey].sort())
  })

  it('boundary derivation works against real parsed schemas', () => {
    const def = doc.graphs['g1'] as GraphDef
    const { schema, diagnostics } = deriveBoundarySchema(def, (t) => schemas.get(t))
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const color = inputsOf(schema!).find((i) => i.id === 'color')!
    expect(color.widget).toBeDefined() // promoted
    const image = outputsOf(schema!).find((o) => o.id === 'image')!
    expect(image.type).toEqual({ kind: 'concrete', name: 'IMAGE' })
  })

  it('the promoted instance value overrides the inner stored value', () => {
    const instanceValues = doc.graphs['g0']!.nodes['n0']!.values as JsonObject
    const innerValues = doc.graphs['g1']!.nodes['n0']!.values as JsonObject
    const flattened = prompt['n0.n0']!.inputs as JsonObject
    expect(instanceValues['color']).toBe(123)
    expect(innerValues['color']).toBe(0)
    expect(flattened['color']).toBe(123) // instance wins
    expect(flattened['width']).toBe(innerValues['width']) // non-promoted stays inner
  })
})
