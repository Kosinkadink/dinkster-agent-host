import { canonicalJson } from '../compile/hash.js'
import { diag, type Diagnostic } from '../diagnostics.js'
import type { JsonObject } from '../format/document.js'
import { ownJson } from '../format/json.js'
import { checkImageDocument } from './invariants.js'
import {
  IMAGE_DOCUMENT_FORMAT,
  IMAGE_DOCUMENT_FORMAT_VERSION,
  MAX_IMAGE_DOCUMENT_BYTES,
  type ImageDocument,
} from './model.js'
import { validateImageDocumentShape } from './validate.js'

const MAX_IMAGE_JSON_NODES = 1_000_000

export interface ImageDocumentMigrationStep {
  readonly from: number
  readonly description: string
  migrate(document: JsonObject): {
    readonly document: JsonObject
    readonly diagnostics: readonly Diagnostic[]
  }
}

export const IMAGE_DOCUMENT_MIGRATIONS: readonly ImageDocumentMigrationStep[] = [{
  from: 1,
  description: 'Preserve the asset-backed document in version 2',
  migrate(document) {
    return { document, diagnostics: [] }
  },
}]

export interface ImageDocumentMigrationResult {
  readonly document?: JsonObject
  readonly diagnostics: readonly Diagnostic[]
}

export function migrateImageDocumentJson(
  raw: JsonObject,
  migrations: readonly ImageDocumentMigrationStep[] = IMAGE_DOCUMENT_MIGRATIONS,
  targetVersion = IMAGE_DOCUMENT_FORMAT_VERSION,
): ImageDocumentMigrationResult {
  const version = raw['formatVersion']
  if (!Number.isSafeInteger(version) || (version as number) < 1) {
    return {
      diagnostics: [diag(
        'error',
        'import',
        'image.version.invalid',
        `formatVersion must be a positive safe integer, got ${JSON.stringify(version)}`,
      )],
    }
  }
  if ((version as number) > targetVersion) {
    return {
      diagnostics: [diag(
        'error',
        'import',
        'image.version.future',
        `ImageDocument formatVersion ${version} is newer than supported version ${targetVersion}`,
      )],
    }
  }

  const diagnostics: Diagnostic[] = []
  const byVersion = new Map(migrations.map((step) => [step.from, step]))
  let document = raw
  let current = version as number
  while (current < targetVersion) {
    const step = byVersion.get(current)
    if (step === undefined) {
      diagnostics.push(diag(
        'error',
        'import',
        'image.version.gap',
        `no ImageDocument migration is registered for version ${current} to ${current + 1}`,
      ))
      return { diagnostics }
    }
    const migrated = step.migrate(document)
    diagnostics.push(...migrated.diagnostics)
    if (migrated.diagnostics.some((item) => item.severity === 'error')) return { diagnostics }
    document = { ...migrated.document, formatVersion: current + 1 }
    current += 1
  }
  return { document, diagnostics }
}

export interface LoadImageDocumentOptions {
  /** Overrides are used to exercise future migration chains in tests. */
  readonly migrations?: readonly ImageDocumentMigrationStep[]
  readonly targetVersion?: number
  readonly maxDocumentBytes?: number
}

export interface LoadImageDocumentResult {
  readonly document?: ImageDocument
  readonly diagnostics: readonly Diagnostic[]
}

export function serializeImageDocument(document: ImageDocument): string {
  return canonicalJson(document)
}

export function loadImageDocument(
  input: unknown,
  options?: LoadImageDocumentOptions,
): LoadImageDocumentResult {
  const requestedMaximum = options?.maxDocumentBytes
  const maximumBytes = typeof requestedMaximum === 'number' &&
      Number.isSafeInteger(requestedMaximum) && requestedMaximum > 0
    ? Math.min(requestedMaximum, MAX_IMAGE_DOCUMENT_BYTES)
    : MAX_IMAGE_DOCUMENT_BYTES
  const ingress = ownJson(input, {
    limits: {
      maxDepth: 64,
      maxNodes: MAX_IMAGE_JSON_NODES,
      maxChars: maximumBytes,
    },
  })
  if (!ingress.ok) {
    return {
      diagnostics: [diag('error', 'import', 'image.notJson', `ImageDocument rejected: ${ingress.reason}`)],
    }
  }
  const inputValue = ingress.value
  if (typeof inputValue !== 'object' || inputValue === null || Array.isArray(inputValue)) {
    return {
      diagnostics: [diag('error', 'import', 'image.format.unknown', 'not a recognizable ImageDocument')],
    }
  }
  const raw = inputValue as JsonObject
  if (raw['format'] !== IMAGE_DOCUMENT_FORMAT) {
    return {
      diagnostics: [diag('error', 'import', 'image.format.unknown', 'not a recognizable ImageDocument')],
    }
  }

  const targetVersion = options?.targetVersion ?? IMAGE_DOCUMENT_FORMAT_VERSION
  if (raw['formatVersion'] === 1) {
    const sourceDiagnostics = validateImageDocumentShape(raw, 1)
    if (sourceDiagnostics.some((item) => item.severity === 'error')) {
      return { diagnostics: sourceDiagnostics }
    }
  }
  const migrated = migrateImageDocumentJson(
    raw,
    options?.migrations ?? IMAGE_DOCUMENT_MIGRATIONS,
    targetVersion,
  )
  if (migrated.document === undefined) return { diagnostics: migrated.diagnostics }

  // Migration output is re-owned before any validator traverses it.
  const owned = ownJson(migrated.document, {
    limits: {
      maxDepth: 64,
      maxNodes: MAX_IMAGE_JSON_NODES,
      maxChars: maximumBytes,
    },
  })
  if (!owned.ok) {
    return {
      diagnostics: [
        ...migrated.diagnostics,
        diag('error', 'import', 'image.notJson', `migrated ImageDocument rejected: ${owned.reason}`),
      ],
    }
  }
  const encodedBytes = new TextEncoder().encode(canonicalJson(owned.value)).byteLength
  if (encodedBytes > maximumBytes) {
    return {
      diagnostics: [
        ...migrated.diagnostics,
        diag(
          'error',
          'import',
          'image.size.exceeded',
          `canonical ImageDocument is ${encodedBytes} bytes; maximum is ${maximumBytes}`,
        ),
      ],
    }
  }

  const shapeDiagnostics = validateImageDocumentShape(owned.value, targetVersion)
  const diagnostics = [...migrated.diagnostics, ...shapeDiagnostics]
  if (shapeDiagnostics.some((item) => item.severity === 'error')) return { diagnostics }
  const document = owned.value as unknown as ImageDocument
  const invariantDiagnostics = checkImageDocument(document)
  const allDiagnostics = [...diagnostics, ...invariantDiagnostics]
  if (invariantDiagnostics.some((item) => item.severity === 'error')) return { diagnostics: allDiagnostics }
  return { document, diagnostics: allDiagnostics }
}
