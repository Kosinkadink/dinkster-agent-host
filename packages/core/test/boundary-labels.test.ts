import { describe, expect, it } from 'vitest'
import { defaultBoundaryLabels } from '../src/schema/boundary-labels.js'
import type { BoundaryItem } from '../src/format/document.js'

const item = (id: string, port = id, displayName?: string): BoundaryItem => ({
  id,
  ...(displayName === undefined ? {} : { displayName }),
  binds: { kind: 'port', node: 'node' as never, port: port as never },
})

describe('generated boundary labels', () => {
  it('hides dynamic member and collision suffixes and disambiguates by stable order', () => {
    const items = [
      item('masks_m4'),
      item('masks_m7'),
      item('image_3'),
    ]
    expect([...defaultBoundaryLabels(items).values()]).toEqual(['Mask', 'Mask 2', 'Image'])
  })

  it('humanizes raw type-like and implementation-style port ids', () => {
    const items = [
      item('raw', 'MASK'),
      item('prompt', 'positive_prompt'),
      item('vae', 'VAE'),
      item('spaced-member', 'Masks M4'),
      item('spaced-ordinal', 'Image 3'),
    ]
    expect([...defaultBoundaryLabels(items).values()]).toEqual(['Mask', 'Positive prompt', 'VAE', 'Mask 2', 'Image'])
  })

  it('keeps a deterministic default behind a custom name', () => {
    const custom = item('masks_m4', 'masks_m4', 'Foreground mask')
    expect(defaultBoundaryLabels([custom]).get(custom.id)).toBe('Mask')
  })
})
