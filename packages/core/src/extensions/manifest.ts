/**
 * Pack extension manifests (architecture section 11, per-contribution gating).
 *
 * The old ecosystem's frontend features are side effects of executing pack
 * JS, so the only off switch is not loading the pack - which is why cloud
 * hosts drop whole packs over frontend behavior they cannot isolate. Here a
 * pack ENUMERATES every contribution in a manifest with stable namespaced
 * ids BEFORE its code activates; nothing is contributed implicitly, so
 * every feature has an individual off switch by construction.
 *
 * The manifest is plain data (JSON-serializable): hosts can read, display,
 * and policy-filter it without running any pack code.
 */

import { diag, type Diagnostic } from '../diagnostics.js'
import { CONTRIBUTION_CATEGORIES, FRONTEND_CONTRIBUTION_KINDS } from './contribution-kinds.generated.js'

export { CONTRIBUTION_CATEGORIES, FRONTEND_CONTRIBUTION_KINDS }

/**
 * Closed vocabulary of gateable contribution categories. Each maps to one
 * typed registry; adding a category is an additive contract change, never
 * a pack-side invention.
 */
export type ContributionCategory = (typeof CONTRIBUTION_CATEGORIES)[number]

/** RFC section 5 authored frontend vocabulary. Authored modules are package-relative. */
export const FRONTEND_PRIVILEGES = ['schema-widget', 'graph-editor-canvas', 'app-workflow', 'event-consumer'] as const
export type FrontendPrivilege = (typeof FRONTEND_PRIVILEGES)[number]
export type FrontendContributionKind = (typeof FRONTEND_CONTRIBUTION_KINDS)[number]

/** Privileges are independent; commands and bindings can belong to either editor or app code. */
export function frontendContributionAuthorized(kind: FrontendContributionKind, privileges: readonly FrontendPrivilege[]): boolean {
  switch (kind) {
    case 'widgetKind': case 'widgetView': case 'previewRenderer': case 'textEditorExtension': case 'workflowImporter':
      return privileges.includes('schema-widget')
    case 'canvasLayer': case 'nodeDecoration': case 'menu': case 'virtualNode':
      return privileges.includes('graph-editor-canvas')
    case 'command': case 'keybinding':
      return privileges.includes('graph-editor-canvas') || privileges.includes('app-workflow')
    case 'hostUi': case 'searchProvider': case 'setting': case 'workflowObserver':
    case 'editor': case 'editorBinding': case 'panel':
      return privileges.includes('app-workflow')
    case 'eventConsumer':
      return privileges.includes('event-consumer')
  }
}

export interface AuthoredFrontendContribution {
  readonly id: string
  readonly kind: FrontendContributionKind
  readonly label?: string
  readonly event?: string
  readonly schema?: string
  readonly schemaVersion?: number
  readonly delivery?: string
}

export interface AuthoredFrontendEntryPoint {
  readonly id: string
  readonly module: string
  readonly privileges: readonly FrontendPrivilege[]
  readonly contributions: readonly AuthoredFrontendContribution[]
}

export interface AuthoredPackManifest {
  readonly id: string
  readonly version: string
  readonly requires: { readonly frontendApi: string }
  readonly entryPoints: { readonly frontend: readonly AuthoredFrontendEntryPoint[] }
}

export interface EffectiveExtensionSnapshot {
  readonly format: 'dinkster.extension-snapshot'
  readonly version: 1
  readonly frontendApi: string
  readonly extensions: readonly EffectiveExtension[]
}

export interface EffectiveExtension {
  readonly id: string
  readonly version: string
  readonly packageDigest: string
  readonly contributionIds: readonly string[]
  readonly selectorResolutions: readonly { readonly selector: string; readonly points: readonly string[] }[]
  readonly serviceProviders: readonly { readonly service: string; readonly provider: string }[]
  readonly capabilities: readonly string[]
  readonly behaviorConfiguration: readonly { readonly key: string; readonly value: string | number | boolean | null }[]
  readonly frontend?: readonly EffectiveFrontendModule[]
  readonly events?: readonly EffectivePackEvent[]
  readonly routes?: readonly EffectivePackRoute[]
}

export type PackJsonScalarType = 'string' | 'integer' | 'number' | 'boolean'
export type PackJsonObject = Readonly<Record<string, string | number | boolean>>
export interface EffectivePackRoute {
  readonly id: string
  readonly method: 'GET' | 'POST'
  readonly handler: string
  readonly request: Readonly<Record<string, PackJsonScalarType>>
  readonly response: Readonly<Record<string, PackJsonScalarType>>
}

export function isPackJsonObject(value: unknown, schema: Readonly<Record<string, PackJsonScalarType>>): value is PackJsonObject {
  return record(value) && Object.keys(value).length === Object.keys(schema).length &&
    Object.entries(schema).every(([key, type]) => {
      const field = value[key]
      return type === 'integer' ? typeof field === 'number' && Number.isSafeInteger(field)
        : type === 'number' ? typeof field === 'number' && Number.isFinite(field)
        : typeof field === type
    }) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= 65536
}

export interface EffectivePackEvent {
  readonly name: string
  readonly payload: Readonly<Record<string, PackJsonScalarType>>
}

export interface EffectiveFrontendModule {
  readonly id: string
  readonly moduleUrl: string
  readonly moduleDigest: string
  readonly authorizedPrivileges: readonly FrontendPrivilege[]
  readonly contributions: readonly AuthoredFrontendContribution[]
}

/** One declared contribution: a stable id the host can gate individually. */
export interface ContributionDecl {
  /**
   * Stable namespaced id, e.g. 'rgthree.menu.groupMuter'. MUST start with
   * `<packId>.` - namespacing is by construction, not review.
   */
  readonly id: string
  readonly category: ContributionCategory
  /** Human-readable name for the gating UI; the id tail is the fallback. */
  readonly label?: string
}

export interface PackManifest {
  /**
   * Pack id: lowercase `[a-z0-9-]+` segments joined by dots ('kj',
   * 'comfy.rgthree-comfy'). 'core' is reserved for the host itself.
   */
  readonly id: string
  readonly displayName?: string
  /**
   * Widget kind ids from OTHER packs this pack's nodes use ('kj.curve').
   * Declared dependencies, not bundling: an absent provider degrades
   * gracefully with a diagnostic naming it - never a hard failure.
   */
  readonly uses?: readonly string[]
  readonly contributions: readonly ContributionDecl[]
}

const PACK_ID = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/
const CONTRIBUTION_TAIL = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const SHA256 = /^sha256:[0-9a-f]{64}$/
const EFFECTIVE_CAPABILITIES = ['accelerator', 'artifacts', 'background-jobs', 'downloads', 'filesystem', 'model-family-registration', 'routes'] as const

const bad = (code: string, message: string): Diagnostic => diag('error', 'extension', code, message)

/**
 * Structural manifest validation. Returns diagnostics; a manifest with any
 * ERROR diagnostic must be refused wholesale (a half-loaded manifest would
 * defeat the "host knows every contribution" guarantee).
 */
export function validateManifest(manifest: PackManifest): readonly Diagnostic[] {
  const problems: Diagnostic[] = []
  if (!PACK_ID.test(manifest.id)) {
    problems.push(bad('extension.pack-id-invalid', `pack id '${manifest.id}' is not a lowercase dotted identifier`))
  }
  if (manifest.id === 'core' || manifest.id.startsWith('core.')) {
    problems.push(bad('extension.pack-id-reserved', `pack id '${manifest.id}' is reserved for the host`))
  }
  const seen = new Set<string>()
  for (const c of manifest.contributions) {
    if (!(CONTRIBUTION_CATEGORIES as readonly string[]).includes(c.category)) {
      problems.push(bad('extension.category-unknown', `contribution '${c.id}' declares unknown category '${c.category}'`))
    }
    if (!c.id.startsWith(`${manifest.id}.`) || !CONTRIBUTION_TAIL.test(c.id.slice(manifest.id.length + 1))) {
      problems.push(
        bad('extension.contribution-id-invalid', `contribution id '${c.id}' must be '${manifest.id}.<name>'`),
      )
    }
    if (seen.has(c.id)) {
      problems.push(bad('extension.contribution-duplicate', `contribution id '${c.id}' declared twice`))
    }
    seen.add(c.id)
  }
  for (const use of manifest.uses ?? []) {
    if (use.startsWith(`${manifest.id}.`)) {
      problems.push(bad('extension.uses-own', `'uses' names this pack's own '${use}'; uses is for OTHER packs`))
    }
  }
  return problems
}

/** Validate the authored RFC section 5 shape before any module import. */
export function validateAuthoredManifest(value: unknown): readonly Diagnostic[] {
  const problems: Diagnostic[] = []
  if (!record(value) || typeof value['id'] !== 'string' || typeof value['version'] !== 'string' || !record(value['requires']) || typeof value['requires']['frontendApi'] !== 'string' || !record(value['entryPoints']) || !Array.isArray(value['entryPoints']['frontend'])) {
    return [bad('extension.manifest-malformed', 'authored frontend manifest has an invalid header')]
  }
  const manifest = value as unknown as AuthoredPackManifest
  if (!PACK_ID.test(manifest.id)) problems.push(bad('extension.pack-id-invalid', `pack id '${manifest.id}' is not a lowercase dotted identifier`))
  if (manifest.id === 'core' || manifest.id.startsWith('core.')) problems.push(bad('extension.pack-id-reserved', `pack id '${manifest.id}' is reserved for the host`))
  if (!parseSemver(manifest.version)) problems.push(bad('extension.pack-version-invalid', `pack '${manifest.id}' version '${manifest.version}' is not SemVer`))
  if (!validFrontendApiRange(manifest.requires.frontendApi)) {
    problems.push(bad('extension.frontend-api-range-invalid', `pack '${manifest.id}' must declare a frontendApi range`))
  }
  const seen = new Set<string>()
  const entryIds = new Set<string>()
  for (const rawEntry of manifest.entryPoints.frontend) {
    if (!record(rawEntry) || typeof rawEntry['id'] !== 'string' || typeof rawEntry['module'] !== 'string' || !stringArray(rawEntry['privileges']) || !Array.isArray(rawEntry['contributions'])) {
      problems.push(bad('extension.entry-point-malformed', `pack '${manifest.id}' contains a malformed frontend entry point`))
      continue
    }
    const entry = rawEntry as unknown as AuthoredFrontendEntryPoint
    if (!validOwnedId(manifest.id, entry.id)) problems.push(bad('extension.entry-point-id-invalid', `entry point id '${entry.id}' must be '${manifest.id}.<name>'`))
    if (entryIds.has(entry.id)) problems.push(bad('extension.entry-point-duplicate', `entry point id '${entry.id}' declared twice`))
    entryIds.add(entry.id)
    if (!/^\.\/(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^?#]+$/.test(entry.module)) {
      problems.push(bad('extension.module-path-invalid', `entry point '${entry.id}' module must be a package-relative './' path`))
    }
    if (new Set(entry.privileges).size !== entry.privileges.length || entry.privileges.some((item) => !(FRONTEND_PRIVILEGES as readonly string[]).includes(item))) {
      problems.push(bad('extension.privilege-invalid', `entry point '${entry.id}' declares invalid or duplicate privileges`))
    }
    for (const rawContribution of entry.contributions) {
      if (!record(rawContribution) || typeof rawContribution['id'] !== 'string' || typeof rawContribution['kind'] !== 'string') {
        problems.push(bad('extension.contribution-malformed', `entry point '${entry.id}' contains a malformed contribution`))
        continue
      }
      const contribution = rawContribution as unknown as AuthoredFrontendContribution
      if (!(FRONTEND_CONTRIBUTION_KINDS as readonly string[]).includes(contribution.kind)) problems.push(bad('extension.kind-unknown', `contribution '${contribution.id}' declares unknown kind '${contribution.kind}'`))
      if (!validOwnedId(manifest.id, contribution.id)) problems.push(bad('extension.contribution-id-invalid', `contribution id '${contribution.id}' must be '${manifest.id}.<name>'`))
      if (seen.has(contribution.id)) problems.push(bad('extension.contribution-duplicate', `contribution id '${contribution.id}' declared twice`))
      seen.add(contribution.id)
    }
  }
  return problems
}

/** Decode backend authority without discovering code or changing the wire version. */
export function decodeEffectiveExtensionSnapshot(value: unknown): { readonly snapshot?: EffectiveExtensionSnapshot; readonly diagnostics: readonly Diagnostic[] } {
  const problems: Diagnostic[] = []
  const fail = (message: string): { readonly diagnostics: readonly Diagnostic[] } => ({ diagnostics: [bad('extension.snapshot-malformed', message)] })
  if (!record(value) || value['format'] !== 'dinkster.extension-snapshot' || value['version'] !== 1 || typeof value['frontendApi'] !== 'string' || !parseSemver(value['frontendApi']) || !Array.isArray(value['extensions'])) {
    return fail('extension snapshot has an invalid header')
  }
  const extensions: EffectiveExtension[] = []
  let previous = ''
  for (const raw of value['extensions']) {
    if (!record(raw) || typeof raw['id'] !== 'string' || !PACK_ID.test(raw['id']) || raw['id'] <= previous || typeof raw['version'] !== 'string' || !parseSemver(raw['version']) || typeof raw['packageDigest'] !== 'string' || !SHA256.test(raw['packageDigest']) || !stringArray(raw['contributionIds']) || new Set(raw['contributionIds']).size !== raw['contributionIds'].length || !selectorRows(raw['selectorResolutions']) || !providerRows(raw['serviceProviders']) || !canonicalVocabulary(raw['capabilities'], EFFECTIVE_CAPABILITIES) || !configurationRows(raw['behaviorConfiguration'])) {
      problems.push(bad('extension.snapshot-malformed', `extension snapshot contains an invalid '${record(raw) && typeof raw['id'] === 'string' ? raw['id'] : 'unknown'}' row`))
      continue
    }
    previous = raw['id']
    if (!frontendRows(raw['id'], raw['frontend']) || !eventRows(raw['events']) || !routeRows(raw['routes'])) {
      problems.push(bad('extension.snapshot-malformed', `extension '${raw['id']}' has invalid frontend, event, or route declarations`))
      continue
    }
    try {
      extensions.push(freezeSnapshotValue(JSON.parse(JSON.stringify(raw))) as EffectiveExtension)
    } catch {
      problems.push(bad('extension.snapshot-malformed', `extension '${raw['id']}' is not JSON data`))
    }
  }
  if (problems.length > 0) return { diagnostics: problems }
  return { snapshot: Object.freeze({ format: 'dinkster.extension-snapshot', version: 1, frontendApi: value['frontendApi'], extensions: Object.freeze(extensions) }), diagnostics: [] }
}

function freezeSnapshotValue(value: unknown): unknown {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freezeSnapshotValue(item)
    Object.freeze(value)
  }
  return value
}

function frontendRows(pack: string, value: unknown): boolean {
  if (value === undefined) return true
  if (!Array.isArray(value)) return false
  const contributions = new Set<string>()
  let previous = ''
  return value.every((row) => {
    if (!record(row) || typeof row['id'] !== 'string' || !validOwnedId(pack, row['id']) || row['id'] <= previous ||
      typeof row['moduleDigest'] !== 'string' || !SHA256.test(row['moduleDigest']) ||
      row['moduleUrl'] !== `/api/extension-assets/${pack}/${row['moduleDigest']}/${row['id']}.js` ||
      !stringArray(row['authorizedPrivileges']) || new Set(row['authorizedPrivileges']).size !== row['authorizedPrivileges'].length ||
      row['authorizedPrivileges'].some((item) => !(FRONTEND_PRIVILEGES as readonly string[]).includes(item)) ||
      !Array.isArray(row['contributions'])) return false
    previous = row['id']
    return row['contributions'].every((item) => {
      if (!record(item) || typeof item['id'] !== 'string' || !validOwnedId(pack, item['id']) || contributions.has(item['id']) ||
        typeof item['kind'] !== 'string' || !(FRONTEND_CONTRIBUTION_KINDS as readonly string[]).includes(item['kind'])) return false
      contributions.add(item['id'])
      return item['kind'] === 'eventConsumer'
        ? typeof item['event'] === 'string' && /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(item['event'])
        : item['event'] === undefined
    })
  })
}

function jsonSchema(value: unknown): value is Readonly<Record<string, PackJsonScalarType>> {
  return record(value) && Object.entries(value).every(([name, type]) => /^[A-Za-z][A-Za-z0-9_]*$/.test(name) &&
    typeof type === 'string' && ['string', 'integer', 'number', 'boolean'].includes(type))
}

function routeRows(value: unknown): boolean {
  if (value === undefined) return true
  if (!Array.isArray(value)) return false
  const ids = new Set<string>()
  return value.every((row) => {
    if (!record(row) || typeof row['id'] !== 'string' || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(row['id']) || ids.has(row['id']) ||
      !['GET', 'POST'].includes(String(row['method'])) || typeof row['handler'] !== 'string' ||
      !jsonSchema(row['request']) || !jsonSchema(row['response'])) return false
    if (row['method'] === 'GET' && Object.keys(row['request']).length !== 0) return false
    ids.add(row['id'])
    return true
  })
}

function eventRows(value: unknown): boolean {
  if (value === undefined) return true
  if (!Array.isArray(value)) return false
  let previous = ''
  return value.every((row) => {
    if (!record(row) || typeof row['name'] !== 'string' || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(row['name']) ||
      row['name'] <= previous || !jsonSchema(row['payload'])) return false
    previous = row['name']
    return (row['schemaVersion'] === undefined || row['schemaVersion'] === 1) &&
      (row['scope'] === undefined || row['scope'] === 'execution') &&
      (row['delivery'] === undefined || row['delivery'] === 'drop-oldest') &&
      (row['maxBytes'] === undefined || row['maxBytes'] === 65536)
  })
}

/** Minimal SemVer range evaluator for the RFC's comparator-set ranges. */
export function frontendApiSatisfies(version: string, range: string): boolean {
  const actual = parseSemver(version)
  if (!actual) return false
  const comparators = range.trim().split(/\s+/).filter(Boolean)
  if (comparators.length === 0) return false
  if (actual.prerelease.length > 0 && !comparators.some((part) => {
    const wanted = parseSemver(part.replace(/^(>=|<=|>|<|=|\^|~)/, ''))
    return wanted !== undefined && wanted.prerelease.length > 0 && wanted.major === actual.major && wanted.minor === actual.minor && wanted.patch === actual.patch
  })) return false
  return comparators.every((part) => {
    const match = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(part)
    if (!match) return false
    const wanted = parseSemver(match[2]!)
    if (!wanted) return false
    const cmp = compareSemver(actual, wanted)
    switch (match[1] ?? '=') {
      case '>=': return cmp >= 0
      case '<=': return cmp <= 0
      case '>': return cmp > 0
      case '<': return cmp < 0
      case '^': return cmp >= 0 && (wanted.major > 0
        ? actual.major === wanted.major
        : wanted.minor > 0
          ? actual.major === 0 && actual.minor === wanted.minor
          : actual.major === 0 && actual.minor === 0 && actual.patch === wanted.patch)
      case '~': return cmp >= 0 && actual.major === wanted.major && actual.minor === wanted.minor
      default: return cmp === 0
    }
  })
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const validOwnedId = (pack: string, id: string): boolean => id.startsWith(`${pack}.`) && CONTRIBUTION_TAIL.test(id.slice(pack.length + 1))
const stringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0)
const canonicalStrings = (value: unknown): value is string[] => stringArray(value) && value.every((item, index) => index === 0 || value[index - 1]! < item)
const canonicalVocabulary = (value: unknown, vocabulary: readonly string[]): value is string[] => canonicalStrings(value) && value.every((item) => vocabulary.includes(item))
const selectorRows = (value: unknown): boolean => Array.isArray(value) && value.every((row, index) => record(row) && typeof row['selector'] === 'string' && row['selector'].length > 0 && canonicalStrings(row['points']) && (index === 0 || (record(value[index - 1]) && typeof value[index - 1]['selector'] === 'string' && value[index - 1]['selector'] < row['selector'])))
const providerRows = (value: unknown): boolean => Array.isArray(value) && value.every((row, index) => record(row) && typeof row['service'] === 'string' && row['service'].length > 0 && typeof row['provider'] === 'string' && row['provider'].length > 0 && (index === 0 || (record(value[index - 1]) && typeof value[index - 1]['service'] === 'string' && value[index - 1]['service'] < row['service'])))
const configurationRows = (value: unknown): boolean => Array.isArray(value) && value.every((row, index) => {
  if (!record(row) || typeof row['key'] !== 'string') return false
  const previous = index === 0 ? undefined : value[index - 1]
  if (previous !== undefined && (!record(previous) || typeof previous['key'] !== 'string' || previous['key'] >= row['key'])) return false
  return row['key'].length > 0 && (row['value'] === null || typeof row['value'] === 'string' || typeof row['value'] === 'boolean' || (typeof row['value'] === 'number' && Number.isSafeInteger(row['value'])))
})
interface ParsedSemver { readonly major: number; readonly minor: number; readonly patch: number; readonly prerelease: readonly (string | number)[] }
const parseSemver = (value: string): ParsedSemver | undefined => {
  const match = SEMVER.exec(value)
  if (!match) return undefined
  const prerelease = match[4]?.split('.').map((part): string | number => /^\d+$/.test(part) ? Number(part) : part) ?? []
  if (match[4]?.split('.').some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) return undefined
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease }
}
const compareSemver = (a: ParsedSemver, b: ParsedSemver): number => {
  const stable = a.major - b.major || a.minor - b.minor || a.patch - b.patch
  if (stable !== 0) return stable
  if (a.prerelease.length === 0 || b.prerelease.length === 0) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const left = a.prerelease[index]
    const right = b.prerelease[index]
    if (left === undefined || right === undefined) return left === right ? 0 : left === undefined ? -1 : 1
    if (left === right) continue
    if (typeof left === 'number' && typeof right === 'string') return -1
    if (typeof left === 'string' && typeof right === 'number') return 1
    return left < right ? -1 : 1
  }
  return 0
}
const validFrontendApiRange = (range: string): boolean => range.trim().length > 0 && range.trim().split(/\s+/).every((part) => /^(>=|<=|>|<|=|\^|~)?(.+)$/.test(part) && parseSemver(part.replace(/^(>=|<=|>|<|=|\^|~)/, '')) !== undefined)
