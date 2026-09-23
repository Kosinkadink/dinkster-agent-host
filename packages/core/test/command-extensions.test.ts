import { describe, expect, it } from 'vitest'
import type { WorkflowDocument } from '../src/format/document.js'
import type { SchemaResolver } from '../src/schema/derive-boundary.js'
import { schemaForEditorRole, type NodeSchema } from '../src/schema/model.js'
import { REGISTERED_COMMAND_EXTENSIONS, registeredExtensionCommands } from '../src/extensions/commands/registry.js'
import { schemaForCommandRole } from '../src/extensions/commands/schema-role.js'

const schema = (type: string, editorRole?: string): NodeSchema => ({
  type,
  displayName: type,
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  ...(editorRole === undefined ? {} : { editorRole }),
  items: [],
})

describe('registered command extensions', () => {
  it('owns each moved command and schema role exactly once', () => {
    expect(
      REGISTERED_COMMAND_EXTENSIONS.map((extension) => ({
        id: extension.id,
        roles: extension.schemaRoles.map((registration) => registration.role),
        commands: extension.commands().map((command) => command.id),
      })),
    ).toEqual([
      {
        id: 'builtin.mask-paint',
        roles: ['image-source', 'mask-paint'],
        commands: ['image.applyMaskPaint'],
      },
      {
        id: 'builtin.image-document',
        roles: ['layers-load', 'layers-flatten', 'layers-edit', 'image-save'],
        commands: ['image.documentExport', 'image.documentRecipeExport'],
      },
      {
        id: 'builtin.compositor',
        roles: ['compositor'],
        commands: ['image.compositorApply'],
      },
    ])
    expect(registeredExtensionCommands().map((command) => command.id)).toEqual([
      'image.applyMaskPaint',
      'image.documentExport',
      'image.documentRecipeExport',
      'image.compositorApply',
    ])
  })

  it('uses authoritative role lookup without falling back when it is available', () => {
    const fallback = schema('fallback')
    const selected = schema('selected', 'image-save')
    const resolve = ((type: string) => (type === fallback.type ? fallback : undefined)) as SchemaResolver & {
      forEditorRole: NonNullable<SchemaResolver['forEditorRole']>
    }
    resolve.forEditorRole = (role) => (role === 'image-save' ? selected : undefined)

    expect(
      schemaForCommandRole({} as WorkflowDocument, { role: 'image-save', fallbackNodeId: fallback.type }, { kind: 'shared-replay' }, resolve),
    ).toBe(selected)
    expect(
      schemaForCommandRole({} as WorkflowDocument, { role: 'missing', fallbackNodeId: fallback.type }, { kind: 'shared-replay' }, resolve),
    ).toBeUndefined()
  })

  it('uses the isolated node id only for resolvers without role lookup', () => {
    const fallback = schema('fallback')
    const resolve: SchemaResolver = (type) => (type === fallback.type ? fallback : undefined)
    expect(
      schemaForCommandRole({} as WorkflowDocument, { role: 'image-save', fallbackNodeId: fallback.type }, { kind: 'shared-replay' }, resolve),
    ).toBe(fallback)
  })

  it('rejects ambiguous schemas for an editor role', () => {
    const selected = schema('selected', 'image-save')
    expect(schemaForEditorRole([selected], 'image-save')).toBe(selected)
    expect(schemaForEditorRole([selected, schema('duplicate', 'image-save')], 'image-save')).toBeUndefined()
  })
})
