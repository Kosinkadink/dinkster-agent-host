/**
 * Golden fixture test: parse a full /object_info capture from a real ComfyUI
 * (fixtures/object_info.json) and hold the parser to it.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseObjectInfo, type ObjectInfoEntry } from '../src/schema/object-info.js'
import { inputsOf, outputsOf } from '../src/schema/model.js'

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/object_info.json')
const raw = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, ObjectInfoEntry>

describe('object_info golden fixture', () => {
  const { schemas, diagnostics } = parseObjectInfo(raw)

  it('parses every node without error-level diagnostics', () => {
    const errors = diagnostics.filter((d) => d.severity === 'error')
    expect(errors).toEqual([])
    expect(schemas.size).toBe(Object.keys(raw).length)
    expect(schemas.size).toBeGreaterThan(700)
  })

  it('parses KSampler with ordered inputs and a seed controller', () => {
    const ks = schemas.get('KSampler')!
    expect(ks).toBeDefined()
    const inputs = inputsOf(ks)
    expect(inputs.map((i) => i.id)).toEqual([
      'model',
      'seed',
      'steps',
      'cfg',
      'sampler_name',
      'scheduler',
      'positive',
      'negative',
      'latent_image',
      'denoise',
    ])
    expect(inputs.find((i) => i.id === 'seed')?.widget?.controller).toBe('after_generate')
    expect(outputsOf(ks)).toHaveLength(1)
  })

  it('parses V3 dynamic constructs on real nodes', () => {
    const withDynamic = [...schemas.values()].filter((s) =>
      inputsOf(s).some((i) => i.dynamic !== undefined),
    )
    expect(withDynamic.length).toBeGreaterThan(50)
    const kinds = new Set(
      withDynamic.flatMap((s) => inputsOf(s).filter((i) => i.dynamic).map((i) => i.dynamic!.kind)),
    )
    expect(kinds.has('autogrow')).toBe(true)
  })

  it('parses output MatchType templates on real nodes', () => {
    const sw = schemas.get('ComfySwitchNode')
    expect(sw).toBeDefined()
    const out = outputsOf(sw!)
    expect(out.some((o) => o.type.kind === 'variable')).toBe(true)
  })

  it('parses the remote combo on LoadImageOutput', () => {
    const s = schemas.get('LoadImageOutput')!
    const remote = inputsOf(s).find((i) => i.widget?.remote)?.widget?.remote
    expect(remote?.route).toBeTruthy()
  })

  it('parses multiline STRING widgets distinctly from single-line', () => {
    const clip = schemas.get('CLIPTextEncode')!
    const text = inputsOf(clip).find((i) => i.id === 'text')!
    expect(text.widget?.widgetType).toBe('STRING')
    expect(text.widget?.options['multiline']).toBe(true)
  })
})
