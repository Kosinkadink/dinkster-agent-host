import { describe, expect, it } from 'vitest'
import {
  GLSL_STATE_PREVIEW_CHANNEL,
  GLSL_STATE_PREVIEW_STREAM,
  glslShaderStateOf,
} from '../src/glsl-shader.js'

const curve = Array.from({ length: 256 }, (_, index) => index / 255)
const state = {
  width: 640,
  height: 480,
  inputs: [
    { name: 'u_image1', stream: 'glsl-input-u_image1' },
    { name: 'u_image4', stream: 'glsl-input-u_image4' },
  ],
  floats: { u_float0: 0.25, u_float19: -2 },
  ints: { u_int3: 7 },
  bools: { u_bool9: true },
  curves: { u_curve2: curve },
}

describe('GLSL runtime state grammar', () => {
  it('accepts exact bounded state, sparse ordered images, and copies nested values', () => {
    const parsed = glslShaderStateOf(state)
    expect(parsed).toEqual(state)
    expect(parsed).not.toBe(state)
    expect(parsed?.inputs).not.toBe(state.inputs)
    expect(parsed?.curves['u_curve2']).not.toBe(curve)
    expect(GLSL_STATE_PREVIEW_CHANNEL).toBe('application/vnd.dinkster.glsl-state+json')
    expect(GLSL_STATE_PREVIEW_STREAM).toBe('glsl-state')
  })

  it.each([
    { ...state, extra: true },
    { ...state, width: 0 },
    { ...state, height: 16_385 },
    { ...state, inputs: [] },
    { ...state, inputs: [{ name: 'u_image5', stream: 'glsl-input-u_image5' }] },
    { ...state, inputs: [{ name: 'u_image1', stream: 'other' }] },
    { ...state, inputs: [...state.inputs].reverse() },
    { ...state, inputs: [state.inputs[0], state.inputs[0]] },
    { ...state, floats: { u_float20: 1 } },
    { ...state, floats: { u_float0: Number.NaN } },
    { ...state, ints: { u_int0: 1.5 } },
    { ...state, bools: { u_bool0: 1 } },
    { ...state, curves: { u_curve4: curve } },
    { ...state, curves: { u_curve0: curve.slice(1) } },
  ])('rejects malformed or unbounded state', (candidate) => {
    expect(glslShaderStateOf(candidate)).toBeUndefined()
  })
})
