import type { Json } from '../format/document.js'
import { ownJson } from '../format/json.js'
import type { CommandInvocation } from '../commands/contract.js'
import { createSignal } from '../reactive/signal.js'

export type SearchHostAction =
  | { readonly kind: 'host'; readonly action: 'command.run'; readonly params: { readonly id: string } }
  | { readonly kind: 'host'; readonly action: 'settings.open'; readonly params: { readonly category: string; readonly id?: string } }
  | { readonly kind: 'host'; readonly action: 'tab.activate'; readonly params: { readonly id: string } }
  | {
      readonly kind: 'host'
      readonly action: 'node.armPlacement'
      readonly params: { readonly type: string; readonly schemaKey: string; readonly backendId: string }
    }

export type SearchAction = { readonly kind: 'command'; readonly invocation: CommandInvocation } | SearchHostAction

export interface SearchPreviewFieldV1 {
  readonly label: string
  readonly value: string
}

/** Static, host-rendered detail for the active result. */
export interface SearchPreviewDescriptorV1 {
  readonly version: 1
  readonly title?: string
  readonly description?: string
  readonly fields?: readonly SearchPreviewFieldV1[]
}

export interface SearchContext {
  readonly activeTab?: { readonly id: string; readonly title: string }
  readonly selection: { readonly nodes: readonly string[] }
  readonly signal: AbortSignal
}

export interface SearchResult {
  readonly id: string
  readonly title: string
  readonly detail?: string
  readonly icon?: string
  readonly score: number
  readonly action: SearchAction
  readonly keywords?: readonly string[]
  readonly preview?: SearchPreviewDescriptorV1
}

export interface SearchProvider {
  readonly id: string
  readonly label: string
  readonly prefix?: string
  readonly priority: number
  /** Marks providers whose query work should be debounced by search hosts. */
  readonly async?: boolean
  query(query: string, context: SearchContext): readonly SearchResult[] | Promise<readonly SearchResult[]>
}

export interface SearchRequest {
  readonly provider: SearchProvider
  readonly query: string
  readonly results: readonly SearchResult[] | Promise<readonly SearchResult[]>
}

export interface SearchRegistry {
  register(provider: SearchProvider): () => void
  list(): readonly SearchProvider[]
  query(query: string, context: SearchContext): readonly SearchRequest[]
  subscribe(listener: () => void): () => void
  /** Suppress change publication while an extension transaction settles. */
  beginBatch(): (commit: boolean) => void
}

export function createSearchRegistry(): SearchRegistry {
  const providers = new Map<string, SearchProvider>()
  const revision = createSignal(0)
  interface BatchFrame {
    ownDirty: boolean
    committedNestedDirty: boolean
    finished: boolean
  }
  const batches: BatchFrame[] = []
  const notify = (): void => {
    const batch = batches.at(-1)
    if (batch !== undefined) batch.ownDirty = true
    else revision.update((value) => value + 1)
  }
  return {
    register(provider) {
      if (providers.has(provider.id)) throw new Error(`search provider '${provider.id}' already registered`)
      if (provider.prefix !== undefined && provider.prefix.length !== 1) throw new Error('search provider prefix must be one character')
      providers.set(provider.id, provider)
      notify()
      let active = true
      return () => {
        if (!active) return
        active = false
        if (providers.get(provider.id) !== provider) return
        providers.delete(provider.id)
        notify()
      }
    },
    list: () => [...providers.values()].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id)),
    query(raw, context) {
      if (context.signal.aborted) return []
      const route = routeSearchProviders(raw, this.list())
      return route.providers
        .map((provider) => ({ provider, query: route.query, results: provider.query(route.query, context) }))
    },
    subscribe(listener) {
      return revision.subscribe(listener)
    },
    beginBatch() {
      const batch: BatchFrame = { ownDirty: false, committedNestedDirty: false, finished: false }
      batches.push(batch)
      return (commit) => {
        if (batch.finished) return
        if (batches.at(-1) !== batch) throw new Error('search registry batches must finish in reverse order')
        batch.finished = true
        batches.pop()
        const dirty = batch.committedNestedDirty || (commit && batch.ownDirty)
        const parent = batches.at(-1)
        if (parent !== undefined) parent.committedNestedDirty ||= dirty
        else if (dirty) revision.update((value) => value + 1)
      }
    },
  }
}

export function routeSearchProviders(raw: string, providers: readonly SearchProvider[]): { readonly providers: readonly SearchProvider[]; readonly query: string } {
  const routed = providers.filter((provider) => provider.prefix === raw.charAt(0))
  return routed.length > 0
    ? { providers: routed, query: raw.slice(1).trimStart() }
    : { providers, query: raw }
}

const EXTENSION_PROVIDER_KEYS = ['id', 'label', 'prefix', 'priority', 'async', 'query'] as const
const EXTENSION_SEARCH_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/
export const EXTENSION_SEARCH_MAX_RESULTS = 200
export const EXTENSION_SEARCH_MAX_PREVIEW_FIELDS = 16
export const EXTENSION_SEARCH_MAX_VISIBLE_STRING_LENGTH = 2_000

function invalidExtensionProvider(): never {
  throw new Error('extension search provider has invalid metadata')
}

function invalidExtensionResults(): never {
  throw new Error('extension search provider returned invalid results')
}

function providerProperties(value: unknown): Readonly<Record<string, unknown>> {
  try {
    if (typeof value !== 'object' || value === null) return invalidExtensionProvider()
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return invalidExtensionProvider()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string' || !(EXTENSION_PROVIDER_KEYS as readonly string[]).includes(key)) {
        return invalidExtensionProvider()
      }
      const descriptor = descriptors[key]
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return invalidExtensionProvider()
    }
    return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]))
  } catch {
    return invalidExtensionProvider()
  }
}

function extensionContext(context: SearchContext): SearchContext {
  const activeTab = context.activeTab === undefined
    ? undefined
    : Object.freeze({ id: context.activeTab.id, title: context.activeTab.title })
  return Object.freeze({
    ...(activeTab === undefined ? {} : { activeTab }),
    selection: Object.freeze({ nodes: Object.freeze([...context.selection.nodes]) }),
    signal: context.signal,
  })
}

function jsonRecord(value: unknown): value is Readonly<Record<string, Json>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(
  value: Readonly<Record<string, Json>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key))
}

function visibleString(value: unknown, maximum = EXTENSION_SEARCH_MAX_VISIBLE_STRING_LENGTH): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function exactStringParams(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, string>> | undefined {
  if (!jsonRecord(value) || !exactKeys(value, required, optional)) return undefined
  for (const key of required) if (!visibleString(value[key], 200)) return undefined
  for (const key of optional) if (Object.hasOwn(value, key) && !visibleString(value[key], 200)) return undefined
  return value as Readonly<Record<string, string>>
}

/** Strictly decode and own one of the host actions supported by Universal Search. */
export function decodeSearchHostAction(value: unknown): SearchHostAction | undefined {
  if (!jsonRecord(value) || !exactKeys(value, ['kind', 'action', 'params']) || value['kind'] !== 'host') return undefined
  if (value['action'] === 'command.run' || value['action'] === 'tab.activate') {
    const params = exactStringParams(value['params'], ['id'])
    if (params === undefined) return undefined
    return Object.freeze({ kind: 'host', action: value['action'], params: Object.freeze({ id: params['id']! }) })
  }
  if (value['action'] === 'settings.open') {
    const params = exactStringParams(value['params'], ['category'], ['id'])
    if (params === undefined) return undefined
    return Object.freeze({
      kind: 'host',
      action: 'settings.open',
      params: Object.freeze({ category: params['category']!, ...(params['id'] === undefined ? {} : { id: params['id'] }) }),
    })
  }
  if (value['action'] === 'node.armPlacement') {
    const params = exactStringParams(value['params'], ['type', 'schemaKey', 'backendId'])
    if (params === undefined) return undefined
    return Object.freeze({
      kind: 'host',
      action: 'node.armPlacement',
      params: Object.freeze({ type: params['type']!, schemaKey: params['schemaKey']!, backendId: params['backendId']! }),
    })
  }
  return undefined
}

function validAction(value: unknown): boolean {
  if (!jsonRecord(value) || typeof value['kind'] !== 'string') return false
  if (value['kind'] === 'host') return decodeSearchHostAction(value) !== undefined
  if (value['kind'] !== 'command' || !exactKeys(value, ['kind', 'invocation'])) return false
  const invocation = value['invocation']
  return jsonRecord(invocation)
    && exactKeys(invocation, ['command', 'params'], ['actor'])
    && visibleString(invocation['command'], 200)
    && (invocation['actor'] === undefined || visibleString(invocation['actor'], 200))
}

function validPreview(value: unknown): boolean {
  if (!jsonRecord(value) || !exactKeys(value, ['version'], ['title', 'description', 'fields'])) return false
  if (value['version'] !== 1) return false
  if (value['title'] !== undefined && !visibleString(value['title'])) return false
  if (value['description'] !== undefined && !visibleString(value['description'])) return false
  const fields = value['fields']
  if (fields !== undefined) {
    if (!Array.isArray(fields) || fields.length > EXTENSION_SEARCH_MAX_PREVIEW_FIELDS) return false
    if (!fields.every((field) => jsonRecord(field)
      && exactKeys(field, ['label', 'value'])
      && visibleString(field['label'], 200)
      && visibleString(field['value']))) return false
  }
  return value['title'] !== undefined || value['description'] !== undefined || (Array.isArray(fields) && fields.length > 0)
}

/** Own and strictly decode one extension provider result batch. */
export function decodeExtensionSearchResults(value: unknown): readonly SearchResult[] {
  const owned = ownJson(value, {
    undefinedProps: 'reject',
    limits: { maxDepth: 12, maxNodes: 20_000, maxChars: 262_144 },
  })
  if (!owned.ok || !Array.isArray(owned.value) || owned.value.length > EXTENSION_SEARCH_MAX_RESULTS) {
    return invalidExtensionResults()
  }
  const ids = new Set<string>()
  for (const result of owned.value) {
    if (!jsonRecord(result) || !exactKeys(result, ['id', 'title', 'score', 'action'], ['detail', 'icon', 'keywords', 'preview'])) {
      return invalidExtensionResults()
    }
    if (!visibleString(result['id'], 200) || ids.has(result['id']) || !visibleString(result['title'])) {
      return invalidExtensionResults()
    }
    ids.add(result['id'])
    if (result['detail'] !== undefined && !visibleString(result['detail'])) return invalidExtensionResults()
    if (result['icon'] !== undefined && !visibleString(result['icon'], 200)) return invalidExtensionResults()
    if (typeof result['score'] !== 'number' || !validAction(result['action'])) return invalidExtensionResults()
    const keywords = result['keywords']
    if (keywords !== undefined && (!Array.isArray(keywords) || keywords.length > 32 || !keywords.every((keyword) => visibleString(keyword, 200)))) {
      return invalidExtensionResults()
    }
    if (result['preview'] !== undefined && !validPreview(result['preview'])) return invalidExtensionResults()
  }
  return owned.value as unknown as readonly SearchResult[]
}

/**
 * Construct a host-owned provider record around an extension callback. The
 * callback receives only a frozen SearchContext, and every returned result is
 * decoded into bounded, frozen data before the registry publishes it.
 */
export function ownExtensionSearchProvider(provider: SearchProvider): SearchProvider {
  const properties = providerProperties(provider)
  const id = properties['id']
  const label = properties['label']
  const prefix = properties['prefix']
  const priority = properties['priority']
  const asynchronous = properties['async']
  const query = properties['query']
  if (!visibleString(id, 200) || !EXTENSION_SEARCH_ID.test(id)
    || !visibleString(label, 200)
    || (prefix !== undefined && (typeof prefix !== 'string' || prefix.length !== 1))
    || typeof priority !== 'number' || !Number.isFinite(priority)
    || (asynchronous !== undefined && typeof asynchronous !== 'boolean')
    || typeof query !== 'function') return invalidExtensionProvider()
  return Object.freeze({
    id,
    label,
    ...(prefix === undefined ? {} : { prefix }),
    priority,
    ...(asynchronous === undefined ? {} : { async: asynchronous }),
    query: (text: string, context: SearchContext) => {
      const output: unknown = query(text, extensionContext(context))
      return Array.isArray(output)
        ? decodeExtensionSearchResults(output)
        : Promise.resolve(output).then(decodeExtensionSearchResults)
    },
  })
}
