import { coreCommandRegistry } from '@dinkster/core'
import { describe, expect, it } from 'vitest'
import { commandCatalog } from '../src/catalog.js'

describe('command catalog', () => {
  it('only documents registered core commands', () => {
    const registry = coreCommandRegistry()
    expect(commandCatalog.map(({ id }) => id).filter((id) => !registry.has(id))).toEqual([])
  })
})
