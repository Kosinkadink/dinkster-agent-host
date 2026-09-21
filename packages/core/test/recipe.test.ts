/**
 * Upstream recipe comparison (compile/recipe.ts): the structural core of
 * exact live companion values. A producer's transitive input closure must
 * compare identical between two lowered prompts for its recorded value to
 * count as provably current; anything unequal, missing, or shape-mismatched
 * is a difference, never a guess.
 */
import { describe, expect, it } from 'vitest'
import { upstreamRecipesEqual, type Prompt } from '../src/index.js'

const P = (nodes: Record<string, { class_type: string; inputs: Record<string, unknown> }>): Prompt =>
  nodes as unknown as Prompt

/** load -> ksampler(seed) -> save; decode hangs off ksampler too. */
const base = P({
  load: { class_type: 'Load', inputs: { name: 'model.safetensors' } },
  seed: { class_type: 'Int', inputs: { value: 42 } },
  sample: { class_type: 'KSampler', inputs: { model: ['load', 0], seed: ['seed', 0], steps: 20 } },
  decode: { class_type: 'Decode', inputs: { latent: ['sample', 0] } },
  save: { class_type: 'Save', inputs: { image: ['decode', 0], prefix: 'out' } },
})

describe('upstreamRecipesEqual', () => {
  it('identical prompts compare equal at every node', () => {
    for (const id of Object.keys(base)) {
      expect(upstreamRecipesEqual(base, base, id)).toBe(true)
    }
  })

  it('a literal change upstream breaks everything downstream, nothing upstream', () => {
    const edited = P({ ...base, seed: { class_type: 'Int', inputs: { value: 43 } } })
    expect(upstreamRecipesEqual(base, edited, 'seed')).toBe(false)
    expect(upstreamRecipesEqual(base, edited, 'sample')).toBe(false)
    expect(upstreamRecipesEqual(base, edited, 'save')).toBe(false)
    expect(upstreamRecipesEqual(base, edited, 'load')).toBe(true) // unrelated branch
  })

  it('an unrelated branch change leaves the queried cone equal', () => {
    const edited = P({ ...base, save: { class_type: 'Save', inputs: { image: ['decode', 0], prefix: 'else' } } })
    expect(upstreamRecipesEqual(base, edited, 'decode')).toBe(true)
    expect(upstreamRecipesEqual(base, edited, 'save')).toBe(false)
  })

  it('rewiring a link (different upstream id) is a difference', () => {
    const edited = P({
      ...base,
      seed2: { class_type: 'Int', inputs: { value: 42 } },
      sample: { class_type: 'KSampler', inputs: { model: ['load', 0], seed: ['seed2', 0], steps: 20 } },
    })
    expect(upstreamRecipesEqual(base, edited, 'sample')).toBe(false)
  })

  it('a changed output slot on the same producer is a difference', () => {
    const edited = P({ ...base, decode: { class_type: 'Decode', inputs: { latent: ['sample', 1] } } })
    expect(upstreamRecipesEqual(base, edited, 'decode')).toBe(false)
  })

  it('a changed stored dynamic choice is a difference even with byte-identical inputs', () => {
    // DynamicCombo and DynamicSlot choices join the backend's schema_signature:
    // the same interface bytes under different choices are different computations.
    const withChoice = (key: string): Prompt => P({
      src: { class_type: 'Load', inputs: { name: 'a' } },
      slot: { class_type: 'Slotted', inputs: { source: ['src', 0], 'source.strength': 1 }, slotVariants: { source: key } } as never,
      save: { class_type: 'Save', inputs: { image: ['slot', 0] } },
    })
    expect(upstreamRecipesEqual(withChoice('text'), withChoice('text'), 'save')).toBe(true)
    expect(upstreamRecipesEqual(withChoice('text'), withChoice('image'), 'slot')).toBe(false)
    expect(upstreamRecipesEqual(withChoice('text'), withChoice('image'), 'save')).toBe(false)
    expect(upstreamRecipesEqual(withChoice('text'), withChoice('image'), 'src')).toBe(true) // upstream untouched
  })

  it('an absent slotVariants object equals an empty one, never a phantom difference', () => {
    const a = P({ n: { class_type: 'X', inputs: {} } })
    const b = { n: { class_type: 'X', inputs: {}, slotVariants: {} } } as unknown as Prompt
    expect(upstreamRecipesEqual(a, b, 'n')).toBe(true)
  })

  it('a changed effective output family is a different upstream recipe', () => {
    const withMembers = (members?: readonly string[]): Prompt => ({
      source: {
        class_type: 'Splitter',
        inputs: { count: 2 },
        ...(members ? { outputMembers: { images: members } } : {}),
      },
      sink: { class_type: 'Save', inputs: { image: ['source', 0] } },
    })
    expect(upstreamRecipesEqual(withMembers(['0', '1']), withMembers(['0', '1']), 'sink')).toBe(true)
    expect(upstreamRecipesEqual(withMembers(['0', '1']), withMembers(['0', '2']), 'sink')).toBe(false)
    expect(upstreamRecipesEqual(withMembers(['0', '1']), withMembers(), 'sink')).toBe(false)
  })

  it('output ID order is recipe identity, and missing compiler proof fails closed', () => {
    const withIds = (outputIds?: readonly string[]): Prompt => ({
      source: { class_type: 'Dynamic', inputs: {}, ...(outputIds === undefined ? {} : { outputIds }) },
      sink: { class_type: 'Save', inputs: { image: ['source', 0] } },
    })
    expect(upstreamRecipesEqual(withIds(['image', 'count']), withIds(['image', 'count']), 'sink')).toBe(true)
    expect(upstreamRecipesEqual(withIds(['image', 'count']), withIds(['count', 'image']), 'sink')).toBe(false)
    expect(upstreamRecipesEqual(withIds(['image', 'count']), withIds(), 'sink')).toBe(false)
    expect(upstreamRecipesEqual(withIds(), withIds([]), 'sink')).toBe(false)
    expect(upstreamRecipesEqual(withIds(), withIds(), 'sink')).toBe(true)
  })

  it('a changed class_type is a difference even with identical inputs', () => {
    const edited = P({ ...base, load: { class_type: 'LoadV2', inputs: { name: 'model.safetensors' } } })
    expect(upstreamRecipesEqual(base, edited, 'sample')).toBe(false)
  })

  it('a node missing from either side is a difference', () => {
    const { seed: _dropped, ...rest } = base
    const missing = P(rest as never)
    expect(upstreamRecipesEqual(base, missing, 'sample')).toBe(false)
    expect(upstreamRecipesEqual(missing, base, 'sample')).toBe(false)
    expect(upstreamRecipesEqual(base, missing, 'load')).toBe(true) // cone excludes it
  })

  it('literal-vs-link on the same input is a difference in both directions', () => {
    const inlined = P({ ...base, sample: { class_type: 'KSampler', inputs: { model: ['load', 0], seed: 42, steps: 20 } } })
    expect(upstreamRecipesEqual(base, inlined, 'sample')).toBe(false)
    expect(upstreamRecipesEqual(inlined, base, 'sample')).toBe(false)
  })

  it('added or removed input keys are a difference', () => {
    const extra = P({ ...base, seed: { class_type: 'Int', inputs: { value: 42, control: 'fixed' } } })
    expect(upstreamRecipesEqual(base, extra, 'sample')).toBe(false)
  })

  it('deep JSON literals compare structurally, key order ignored', () => {
    const a = P({ n: { class_type: 'T', inputs: { cfg: { a: 1, b: [1, 2, { c: null }] } } } })
    const b = P({ n: { class_type: 'T', inputs: { cfg: { b: [1, 2, { c: null }], a: 1 } } } })
    const c = P({ n: { class_type: 'T', inputs: { cfg: { a: 1, b: [1, 2, { c: 0 }] } } } })
    expect(upstreamRecipesEqual(a, b, 'n')).toBe(true)
    expect(upstreamRecipesEqual(a, c, 'n')).toBe(false)
  })

  it('diamond fan-in visits shared upstream once and compares equal', () => {
    const diamond = P({
      src: { class_type: 'Int', inputs: { value: 1 } },
      left: { class_type: 'A', inputs: { x: ['src', 0] } },
      right: { class_type: 'B', inputs: { x: ['src', 0] } },
      join: { class_type: 'C', inputs: { l: ['left', 0], r: ['right', 0] } },
    })
    expect(upstreamRecipesEqual(diamond, diamond, 'join')).toBe(true)
  })

  it('a queried id absent from both prompts is a difference (never vacuous truth)', () => {
    expect(upstreamRecipesEqual(base, base, 'ghost')).toBe(false)
  })
})
