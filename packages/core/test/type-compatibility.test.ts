import { describe, expect, it } from 'vitest'
import { canonicalCompatTypeId, canonicalCompatTypeIdOf, typesCompatible } from '../src/schema/type-compatibility.js'
import type { TypeExpr } from '../src/schema/model.js'

const c = (name: string): TypeExpr => ({ kind: 'concrete', name })
const u = (...names: string[]): TypeExpr => ({ kind: 'union', names })
const list = (element: TypeExpr): TypeExpr => ({ kind: 'list', element })
const asset = (element: TypeExpr): TypeExpr => ({ kind: 'asset', element })
const wild: TypeExpr = { kind: 'wildcard' }

describe('typesCompatible', () => {
  it('matches equal concrete types and rejects different ones', () => {
    expect(typesCompatible(c('IMAGE'), c('IMAGE'))).toBe(true)
    expect(typesCompatible(c('IMAGE'), c('LATENT'))).toBe(false)
  })

  it('wildcard matches everything on either side', () => {
    expect(typesCompatible(wild, c('IMAGE'))).toBe(true)
    expect(typesCompatible(c('IMAGE'), wild)).toBe(true)
    expect(typesCompatible(wild, wild)).toBe(true)
  })

  it('unions intersect', () => {
    expect(typesCompatible(u('IMAGE', 'MASK'), c('MASK'))).toBe(true)
    expect(typesCompatible(u('IMAGE', 'MASK'), u('LATENT', 'MASK'))).toBe(true)
    expect(typesCompatible(u('IMAGE'), u('LATENT'))).toBe(false)
  })

  it('unconstrained variables match everything; constrained ones use allowed sets', () => {
    const anyVar: TypeExpr = { kind: 'variable', templateId: 'T' }
    const imgVar: TypeExpr = { kind: 'variable', templateId: 'T', allowedTypes: [c('IMAGE')] }
    expect(typesCompatible(anyVar, c('LATENT'))).toBe(true)
    expect(typesCompatible(imgVar, c('IMAGE'))).toBe(true)
    expect(typesCompatible(imgVar, c('LATENT'))).toBe(false)
  })

  it('treats dinkster.save_target as an ordinary exact atom, never as core.string', () => {
    expect(typesCompatible(c('dinkster.save_target'), c('dinkster.save_target'))).toBe(true)
    expect(typesCompatible(c('core.string'), c('dinkster.save_target'))).toBe(false)
    expect(typesCompatible(c('dinkster.save_target'), c('core.string'))).toBe(false)
  })
})

describe('interchangeable comfy-compat atoms', () => {
  it('dinkster.image and comfy.IMAGE match in both directions', () => {
    expect(typesCompatible(c('dinkster.image'), c('comfy.IMAGE'))).toBe(true)
    expect(typesCompatible(c('comfy.IMAGE'), c('dinkster.image'))).toBe(true)
    expect(typesCompatible(c('dinkster.image'), c('dinkster.image'))).toBe(true)
  })

  it('canonicalization lifts through structured types', () => {
    expect(typesCompatible(list(c('dinkster.image')), list(c('comfy.IMAGE')))).toBe(true)
    expect(typesCompatible(list(c('comfy.IMAGE')), list(c('dinkster.image')))).toBe(true)
    // The single asset decode step also bridges the pair.
    expect(typesCompatible(asset(c('dinkster.image')), c('comfy.IMAGE'))).toBe(true)
    expect(typesCompatible(asset(c('comfy.IMAGE')), c('dinkster.image'))).toBe(true)
  })

  it('canonicalization applies inside unions and variable domains', () => {
    expect(typesCompatible(u('dinkster.image', 'LATENT'), c('comfy.IMAGE'))).toBe(true)
    const imgVar: TypeExpr = { kind: 'variable', templateId: 'T', allowedTypes: [c('comfy.IMAGE')] }
    expect(typesCompatible(c('dinkster.image'), imgVar)).toBe(true)
  })

  it('dinkster.mask and comfy.MASK match in both directions', () => {
    expect(typesCompatible(c('dinkster.mask'), c('comfy.MASK'))).toBe(true)
    expect(typesCompatible(c('comfy.MASK'), c('dinkster.mask'))).toBe(true)
    expect(typesCompatible(list(c('dinkster.mask')), list(c('comfy.MASK')))).toBe(true)
    expect(typesCompatible(asset(c('dinkster.mask')), c('comfy.MASK'))).toBe(true)
  })

  it('does not widen either id to unrelated atoms', () => {
    expect(typesCompatible(c('dinkster.image'), c('comfy.MASK'))).toBe(false)
    expect(typesCompatible(c('comfy.MASK'), c('dinkster.image'))).toBe(false)
    // The pairs canonicalize independently: image never crosses to mask.
    expect(typesCompatible(c('dinkster.mask'), c('comfy.IMAGE'))).toBe(false)
    expect(typesCompatible(c('dinkster.mask'), c('dinkster.image'))).toBe(false)
  })

  it('canonicalCompatTypeId collapses spellings while keeping wrappers', () => {
    expect(canonicalCompatTypeId('dinkster.image')).toBe('comfy.IMAGE')
    expect(canonicalCompatTypeId('comfy.IMAGE')).toBe('comfy.IMAGE')
    expect(canonicalCompatTypeId('dinkster.mask')).toBe('comfy.MASK')
    expect(canonicalCompatTypeId('comfy.MASK')).toBe('comfy.MASK')
    expect(canonicalCompatTypeId('list<dinkster.image>')).toBe('list<comfy.IMAGE>')
    expect(canonicalCompatTypeId('asset<list<dinkster.image>>')).toBe('asset<list<comfy.IMAGE>>')
    // Non-interchangeable ids pass through untouched.
    expect(canonicalCompatTypeId('dinkster.latent')).toBe('dinkster.latent')
    expect(canonicalCompatTypeId('list<LATENT>')).toBe('list<LATENT>')
  })

  it('canonicalCompatTypeIdOf resolves closed exprs and rejects open ones', () => {
    expect(canonicalCompatTypeIdOf(c('dinkster.image'))).toBe('comfy.IMAGE')
    expect(canonicalCompatTypeIdOf(list(c('dinkster.image')))).toBe('list<comfy.IMAGE>')
    expect(canonicalCompatTypeIdOf(c('LATENT'))).toBe('LATENT')
    expect(canonicalCompatTypeIdOf(wild)).toBeUndefined()
  })
})
