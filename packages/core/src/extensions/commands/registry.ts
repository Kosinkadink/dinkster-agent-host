import type { CommandDefinition } from '../../commands/contract.js'
import type { SchemaResolver } from '../../schema/derive-boundary.js'
import { COMPOSITOR_COMMAND_EXTENSION } from './compositor.js'
import { IMAGE_DOCUMENT_COMMAND_EXTENSION } from './image-document.js'
import { MASK_PAINT_COMMAND_EXTENSION } from './mask-paint.js'
import type { CommandSchemaRole } from './schema-role.js'

export interface RegisteredCommandExtension {
  readonly id: string
  readonly schemaRoles: readonly CommandSchemaRole[]
  readonly commands: (resolve?: SchemaResolver) => readonly CommandDefinition[]
}

export const REGISTERED_COMMAND_EXTENSIONS: readonly RegisteredCommandExtension[] = [
  MASK_PAINT_COMMAND_EXTENSION,
  IMAGE_DOCUMENT_COMMAND_EXTENSION,
  COMPOSITOR_COMMAND_EXTENSION,
]

export function registeredExtensionCommands(resolve?: SchemaResolver): readonly CommandDefinition[] {
  const extensionIds = new Set<string>()
  const roleOwners = new Map<string, string>()
  const commandIds = new Set<string>()
  const commands: CommandDefinition[] = []
  for (const extension of REGISTERED_COMMAND_EXTENSIONS) {
    if (extensionIds.has(extension.id)) throw new Error(`duplicate command extension id '${extension.id}'`)
    extensionIds.add(extension.id)
    for (const registration of extension.schemaRoles) {
      const owner = roleOwners.get(registration.role)
      if (owner !== undefined) {
        throw new Error(`schema role '${registration.role}' is registered by '${owner}' and '${extension.id}'`)
      }
      roleOwners.set(registration.role, extension.id)
    }
    for (const command of extension.commands(resolve)) {
      if (commandIds.has(command.id)) throw new Error(`duplicate extension command id '${command.id}'`)
      commandIds.add(command.id)
      commands.push(command)
    }
  }
  return commands
}
