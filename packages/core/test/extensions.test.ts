/**
 * Extension manifests + gating host: packs enumerate contributions before
 * activating, the host registers only what gates admit, disabling
 * unregisters cleanly at every granularity, and deployment policy is
 * hard-off (user gates cannot override it). Nodes are untouched by design -
 * nothing here ever sees a schema.
 */
import { describe, expect, it } from 'vitest'
import { createMenuRegistry, type MenuContribution, type MenuContext } from '../src/menus/contract.js'
import { createSearchRegistry, type SearchContext, type SearchProvider, type SearchResult } from '../src/search/contract.js'
import { createSearchSession } from '../src/search/session.js'
import {
  decodeEffectiveExtensionSnapshot,
  frontendApiSatisfies,
  frontendContributionAuthorized,
  FRONTEND_CONTRIBUTION_KINDS,
  FRONTEND_PRIVILEGES,
  validateAuthoredManifest,
  validateManifest,
  type AuthoredPackManifest,
  type PackManifest,
} from '../src/extensions/manifest.js'
import { ExtensionHost, emptyGates, type GateState } from '../src/extensions/host.js'
import type { VirtualNodeKind } from '../src/virtual-node.js'
import type { PreviewRenderer, WidgetKind, WidgetRegistry, WidgetView } from '../src/widgets/contract.js'

/** Minimal contract-faithful widget registry (the real one lives in @dinkster/widgets). */
function fakeWidgets(): WidgetRegistry {
  const kinds = new Map<string, WidgetKind>()
  const views = new Map<string, WidgetView[]>()
  const editors = new Map<string, unknown>()
  const previews: PreviewRenderer[] = []
  return {
    registerKind(kind) {
      if (kinds.has(kind.type)) throw new Error(`dup kind ${kind.type}`)
      kinds.set(kind.type, kind)
      return () => void kinds.delete(kind.type)
    },
    registerView(view) {
      views.set(view.kind, [...(views.get(view.kind) ?? []), view])
      return () => views.set(view.kind, (views.get(view.kind) ?? []).filter((v) => v !== view))
    },
    registerEditor(widgetType, editor) {
      editors.set(widgetType, editor)
      return () => void editors.delete(widgetType)
    },
    registerPreviewRenderer(r) {
      previews.push(r)
      return () => void previews.splice(previews.indexOf(r), 1)
    },
    kind: (type) => kinds.get(type),
    viewsFor: (kindType) => views.get(kindType) ?? [],
    editorFor: (widgetType) => editors.get(widgetType),
    previewRendererFor: (channel) => previews.find((r) => r.canRender(channel)),
  }
}

const widgetKind = (type: string): WidgetKind => ({
  type,
  valueSchema: { version: 1, validate: (v): v is number => typeof v === 'number' },
  defaultValue: () => 0,
  validate: () => [],
  defaultView: () => `${type}.view`,
})

const menuContribution = (id: string): MenuContribution => ({
  id,
  targets: ['node'],
  group: '50-pack',
  resolve: () => [{ id: `${id}.item`, label: 'Pack item', action: { kind: 'host', action: 'noop' } }],
})

const nodeCtx = {
  target: { kind: 'node', nodeId: 'n1' },
  selection: { nodes: [], links: [], reroutes: [], valueSources: [], selectors: [] },
  worldX: 0,
  worldY: 0,
} as unknown as MenuContext

it('keeps the authored frontend vocabulary to the supported contribution kinds', () => {
  expect(FRONTEND_CONTRIBUTION_KINDS).toEqual([
    'widgetKind', 'widgetView', 'previewRenderer', 'textEditorExtension',
    'menu', 'command', 'keybinding', 'setting', 'canvasLayer', 'nodeDecoration',
    'hostUi', 'searchProvider', 'workflowObserver', 'eventConsumer', 'workflowImporter',
    'editor', 'editorBinding', 'panel', 'virtualNode',
  ])
})

it('keeps the four frontend privileges independent', () => {
  const examples = ['widgetView', 'menu', 'hostUi', 'eventConsumer'] as const
  for (const [index, privilege] of FRONTEND_PRIVILEGES.entries()) {
    expect(examples.map((kind) => frontendContributionAuthorized(kind, [privilege])))
      .toEqual(examples.map((_, candidate) => candidate === index))
  }
})

const manifest = (over?: Partial<PackManifest>): PackManifest => ({
  id: 'rgthree',
  displayName: 'rgthree',
  contributions: [
    { id: 'rgthree.menu.muter', category: 'menu', label: 'Group muter menu' },
    { id: 'rgthree.widget.power', category: 'widgetKind', label: 'Power widget' },
  ],
  ...over,
})

function host(over?: { policy?: { allow?: string[]; deny?: string[] }; gates?: GateState }) {
  const menus = createMenuRegistry()
  const widgets = fakeWidgets()
  const textExtensions = new Map<string, { readonly id: string }>()
  const search = createSearchRegistry()
  const gateLog: GateState[] = []
  const h = new ExtensionHost({
    menus,
    widgets,
    registerTextEditorExtension: (extension) => {
      if (textExtensions.has(extension.id)) throw new Error(`dup text extension ${extension.id}`)
      textExtensions.set(extension.id, extension)
      return () => {
        if (textExtensions.get(extension.id) === extension) textExtensions.delete(extension.id)
      }
    },
    registerSearchProvider: (provider) => search.register(provider),
    beginRegistryBatch: () => search.beginBatch(),
    ...(over?.policy ? { policy: over.policy } : {}),
    initialGates: over?.gates ?? emptyGates,
    onGatesChanged: (g) => {
      gateLog.push(g)
    },
  })
  return { h, menus, widgets, textExtensions, search, gateLog }
}

/** Install the standard two-contribution pack; returns what it contributed. */
function installPack(h: ExtensionHost) {
  return h.register(manifest(), (api) => {
    api.menu('rgthree.menu.muter', menuContribution('rgthree.menu.muter'))
    api.widgetKind('rgthree.widget.power', widgetKind('rgthree.widget.power'))
  })
}

describe('validateManifest', () => {
  it('accepts a well-formed manifest', () => {
    expect(validateManifest(manifest())).toEqual([])
  })

  it('rejects bad pack ids, reserved core, foreign/duplicate contribution ids, unknown categories', () => {
    const cases: [PackManifest, string][] = [
      [manifest({ id: 'Bad Pack' }), 'extension.pack-id-invalid'],
      [manifest({ id: 'core' }), 'extension.pack-id-reserved'],
      [manifest({ id: 'core.sub' }), 'extension.pack-id-reserved'],
      [
        manifest({ contributions: [{ id: 'other.menu.x', category: 'menu' }] }),
        'extension.contribution-id-invalid',
      ],
      [
        manifest({
          contributions: [
            { id: 'rgthree.a', category: 'menu' },
            { id: 'rgthree.a', category: 'menu' },
          ],
        }),
        'extension.contribution-duplicate',
      ],
      [
        manifest({ contributions: [{ id: 'rgthree.a', category: 'not-real' as never }] }),
        'extension.category-unknown',
      ],
      [manifest({ uses: ['rgthree.widget.power'] }), 'extension.uses-own'],
    ]
    for (const [m, code] of cases) {
      expect(validateManifest(m).map((d) => d.code)).toContain(code)
    }
  })
})

it('registers a synthetic pack virtual node and exposes its renderer', () => {
  const rendered: VirtualNodeKind[] = []
  const h = new ExtensionHost({
    menus: createMenuRegistry(),
    widgets: fakeWidgets(),
    registerVirtualNode: (kind) => {
      rendered.push(kind)
      return () => void rendered.splice(rendered.indexOf(kind), 1)
    },
  })
  const kind: VirtualNodeKind = {
    id: 'notes.callout', title: 'Callout',
    schema: {
      type: 'notes.callout', virtual: true, displayName: 'Callout', category: 'Notes',
      source: 'v3', isOutputNode: false, items: [],
    },
    defaultValues: { text: 'Hello' },
    render: (node) => ({ text: String(node.values['text'] ?? ''), format: 'plain' }),
  }
  expect(h.register({
    id: 'notes',
    contributions: [{ id: 'notes.callout', category: 'virtualNode' }],
  }, (api) => api.virtualNode('notes.callout', kind))).toEqual([])
  expect(rendered).toEqual([kind])
  expect(rendered[0]!.render({
    id: 'n1' as never, type: 'notes.callout', virtual: true,
    values: { text: 'Rendered' },
  })).toEqual({ text: 'Rendered', format: 'plain' })
  h.unregister('notes')
  expect(rendered).toEqual([])
})

it('rejects virtual node kinds without a virtual port-free schema', () => {
  const base: VirtualNodeKind = {
    id: 'notes.callout', title: 'Callout', defaultValues: {},
    schema: {
      type: 'notes.callout', virtual: true, displayName: 'Callout', category: 'Notes',
      source: 'v3', isOutputNode: false, items: [],
    },
    render: () => ({ text: '', format: 'plain' }),
  }
  const register = (kind: VirtualNodeKind) => {
    const h = new ExtensionHost({ menus: createMenuRegistry(), widgets: fakeWidgets() })
    return h.register({
      id: 'notes', contributions: [{ id: kind.id, category: 'virtualNode' }],
    }, (api) => api.virtualNode(kind.id, kind))
  }
  const { virtual: _virtual, ...executableSchema } = base.schema
  expect(register({ ...base, schema: executableSchema })).toContainEqual(
    expect.objectContaining({ code: 'extension.activate-failed' }),
  )
  expect(register({
    ...base,
    schema: {
      ...base.schema,
      items: [{
        kind: 'output', id: 'out',
        type: { kind: 'concrete', name: 'core.string' },
      }],
    },
  })).toContainEqual(expect.objectContaining({ code: 'extension.activate-failed' }))
})

describe('F0 authored and effective manifests', () => {
  const authored: AuthoredPackManifest = {
    id: 'comfy.monitor',
    version: '1.2.0',
    requires: { frontendApi: '>=1.0.0 <2.0.0' },
    entryPoints: { frontend: [{
      id: 'comfy.monitor.frontend.status',
      module: './dist/status.js',
      privileges: ['app-workflow'],
      contributions: [
        { id: 'comfy.monitor.ui.status', kind: 'hostUi' },
        { id: 'comfy.monitor.search.status', kind: 'searchProvider' },
      ],
    }] },
  }

  it('validates package-relative authored entry points, namespaces, privileges, and API ranges', () => {
    expect(validateAuthoredManifest(authored)).toEqual([])
    expect(frontendApiSatisfies('1.3.0', authored.requires.frontendApi)).toBe(true)
    expect(frontendApiSatisfies('2.0.0', authored.requires.frontendApi)).toBe(false)
    expect(validateAuthoredManifest({
      ...authored,
      entryPoints: { frontend: [{ ...authored.entryPoints.frontend[0]!, module: 'https://evil.test/code.js' }] },
    }).map((problem) => problem.code)).toContain('extension.module-path-invalid')
    expect(frontendApiSatisfies('0.3.0', '^0.2.3')).toBe(false)
    expect(frontendApiSatisfies('0.0.4', '^0.0.3')).toBe(false)
    expect(frontendApiSatisfies('1.0.0-alpha', '>=0.9.0')).toBe(false)
    expect(frontendApiSatisfies('1.0.0-alpha.01', '>=1.0.0-alpha')).toBe(false)
  })

  it('returns diagnostics instead of throwing for malformed authored inputs', () => {
    for (const value of [null, {}, { id: 'pack', version: '1.0.0', requires: {}, entryPoints: {} }, {
      id: 'pack', version: '1.0.0', requires: { frontendApi: '>=1.0.0' }, entryPoints: { frontend: [{ id: 'pack.entry', module: './entry.js' }] },
    }]) expect(() => validateAuthoredManifest(value)).not.toThrow()
  })

  it('decodes only the canonical S0-B effective snapshot shape', () => {
    const result = decodeEffectiveExtensionSnapshot({
      format: 'dinkster.extension-snapshot', version: 1, frontendApi: '1.0.0', extensions: [{
        id: 'comfy.monitor', version: '1.2.0', packageDigest: `sha256:${'a'.repeat(64)}`,
        contributionIds: ['events/monitor'], selectorResolutions: [], serviceProviders: [],
        capabilities: ['routes'], behaviorConfiguration: [{ key: 'enabled', value: true }],
      }],
    })
    expect(result.diagnostics).toEqual([])
    expect(result.snapshot?.extensions[0]?.id).toBe('comfy.monitor')
    expect(decodeEffectiveExtensionSnapshot({ format: 'dinkster.extension-snapshot', version: 1, frontendApi: '1.0.0', extensions: [{ id: 'broken' }] }).diagnostics[0]?.code).toBe('extension.snapshot-malformed')
  })

  it('owns immutable backend module/event declarations and rejects asset identity drift', () => {
    const digest = `sha256:${'a'.repeat(64)}`
    const module = {
      id: 'demo.frontend', moduleUrl: `/api/extension-assets/demo/${digest}/demo.frontend.js`, moduleDigest: digest,
      authorizedPrivileges: ['event-consumer'], contributions: [{ id: 'demo.consumer', kind: 'eventConsumer', event: 'demo.initialized' }],
    }
    const decode = (entry = module) => decodeEffectiveExtensionSnapshot({
      format: 'dinkster.extension-snapshot', version: 1, frontendApi: '1.0.0', extensions: [{
        id: 'demo', version: '1.0.0', packageDigest: digest, contributionIds: [], selectorResolutions: [], serviceProviders: [],
        capabilities: ['accelerator', 'artifacts'], behaviorConfiguration: [], frontend: [entry],
        events: [{ name: 'demo.initialized', payload: { count: 'integer' } }],
      }],
    })
    const result = decode()
    expect(result.diagnostics).toEqual([])
    expect(result.snapshot?.extensions[0]?.frontend?.[0]).toEqual(module)
    expect(Object.isFrozen(result.snapshot?.extensions[0]?.frontend?.[0]?.contributions)).toBe(true)
    for (const change of [
      { moduleUrl: 'https://external.test/code.js' }, { moduleUrl: `${module.moduleUrl}?version=2` },
      { moduleDigest: `sha256:${'b'.repeat(64)}` }, { id: 'other.frontend' },
      { authorizedPrivileges: ['event-consumer', 'event-consumer'] }, { authorizedPrivileges: ['admin'] },
      { contributions: [{ id: 'demo.consumer', kind: 'eventConsumer', event: 'unnamespaced' }] },
    ]) expect(decode({ ...module, ...change }).snapshot).toBeUndefined()
    module.contributions[0]!.event = 'demo.changed'
    expect(result.snapshot?.extensions[0]?.frontend?.[0]?.contributions[0]?.event).toBe('demo.initialized')
  })
})

describe('ExtensionHost activation', () => {
  it('registers declared contributions into the real registries', () => {
    const { h, menus, widgets } = host()
    expect(installPack(h)).toEqual([])
    expect(menus.resolve(nodeCtx).flatMap((g) => g.items.map((i) => i.id))).toContain('rgthree.menu.muter.item')
    expect(widgets.kind('rgthree.widget.power')).toBeDefined()
  })

  it('registers and disposes text editor extension contributions across reload', () => {
    const { h, textExtensions } = host()
    const textManifest = manifest({ contributions: [
      { id: 'rgthree.text.complete', category: 'textEditorExtension' },
    ] })
    const install = () => h.register(textManifest, (api) => {
      api.textEditorExtension('rgthree.text.complete', { id: 'rgthree.text.complete' })
    })
    expect(install()).toEqual([])
    expect([...textExtensions]).toHaveLength(1)
    h.unregister('rgthree')
    expect([...textExtensions]).toHaveLength(0)
    expect(install()).toEqual([])
    expect([...textExtensions]).toHaveLength(1)
  })

  it('owns, bounds, gates, and disposes typed search-provider data', () => {
    const { h, search } = host()
    const contexts: SearchContext[] = []
    const raw = [{
      id: 'open-demo', title: 'Open demo', detail: 'Extension result', score: 1,
      action: { kind: 'host', action: 'settings.open', params: { category: 'demo' } },
      keywords: ['demo'],
      preview: { version: 1, description: 'Host-rendered detail', fields: [{ label: 'Source', value: 'Demo pack' }] },
    }]
    const searchManifest = manifest({ contributions: [
      { id: 'rgthree.search.demo', category: 'searchProvider' },
    ] })
    expect(h.register(searchManifest, (api) => {
      api.searchProvider('rgthree.search.demo', {
        id: 'rgthree.search.demo', label: 'Demo results', prefix: '?', priority: 25,
        query: (_query, context) => { contexts.push(context); return raw as never },
      })
    })).toEqual([])
    expect(search.list().map((provider) => provider.id)).toEqual(['rgthree.search.demo'])
    const controller = new AbortController()
    const request = search.query('? open', {
      activeTab: { id: 'tab-1', title: 'Workflow' }, selection: { nodes: ['node-1'] }, signal: controller.signal,
    })[0]!
    const results = request.results as readonly { readonly title: string; readonly preview?: object }[]
    raw[0]!.title = 'mutated after return'
    expect(results[0]?.title).toBe('Open demo')
    expect(Object.isFrozen(results)).toBe(true)
    expect(Object.isFrozen(results[0])).toBe(true)
    expect(Object.isFrozen(results[0]?.preview)).toBe(true)
    expect(Object.keys(contexts[0]!).sort()).toEqual(['activeTab', 'selection', 'signal'])
    expect(Object.keys(contexts[0]!.selection)).toEqual(['nodes'])
    expect(Object.isFrozen(contexts[0])).toBe(true)
    expect(Object.isFrozen(contexts[0]!.selection.nodes)).toBe(true)
    expect(contexts[0]!.signal).toBe(controller.signal)
    expect('document' in contexts[0]!).toBe(false)
    expect('canvas' in contexts[0]!).toBe(false)
    expect('socket' in contexts[0]!).toBe(false)

    h.setContributionEnabled('rgthree.search.demo', false)
    expect(search.list()).toEqual([])
    h.setContributionEnabled('rgthree.search.demo', true)
    expect(search.list().map((provider) => provider.id)).toEqual(['rgthree.search.demo'])
    h.unregister('rgthree')
    expect(search.list()).toEqual([])
  })

  it('rejects provider-owned presentation and malformed result data', () => {
    const badMetadata = host()
    const metadataOut = badMetadata.h.register(manifest({ contributions: [
      { id: 'rgthree.search.demo', category: 'searchProvider' },
    ] }), (api) => {
      api.searchProvider('rgthree.search.demo', {
        id: 'rgthree.search.demo', label: 'Demo', priority: 1, query: () => [], className: 'pack-ui',
      } as SearchProvider)
    })
    expect(metadataOut.map((problem) => problem.code)).toEqual(['extension.activate-failed', 'extension.rollback-complete'])
    expect(badMetadata.search.list()).toEqual([])

    const malformed = host()
    expect(malformed.h.register(manifest({ contributions: [
      { id: 'rgthree.search.demo', category: 'searchProvider' },
    ] }), (api) => {
      api.searchProvider('rgthree.search.demo', {
        id: 'rgthree.search.demo', label: 'Demo', priority: 1,
        query: () => [{
          id: 'bad', title: 'Bad result', score: 1,
          action: { kind: 'host', action: 'settings.open' },
          preview: { version: 1, description: 'detail', className: 'pack-ui' },
        }] as never,
      })
    })).toEqual([])
    expect(() => malformed.search.query('', { selection: { nodes: [] }, signal: new AbortController().signal })).toThrow('invalid results')

    for (const action of [
      { kind: 'host', action: 'node.armPlacement', params: { type: 7, schemaKey: {}, backendId: [] } },
      { kind: 'host', action: 'settings.open', params: { category: 7, id: [] } },
      { kind: 'host', action: 'settings.open', params: { category: 'General', extra: 'unowned' } },
      { kind: 'host', action: 'unknown', params: { id: 'value' } },
    ]) {
      const boundary = host()
      expect(boundary.h.register(manifest({ contributions: [
        { id: 'rgthree.search.demo', category: 'searchProvider' },
      ] }), (api) => {
        api.searchProvider('rgthree.search.demo', {
          id: 'rgthree.search.demo', label: 'Demo', priority: 1,
          query: () => [{ id: 'bad', title: 'Bad result', score: 1, action }] as never,
        })
      })).toEqual([])
      expect(() => boundary.search.query('', { selection: { nodes: [] }, signal: new AbortController().signal })).toThrow('invalid results')
    }
  })

  it('does not publish a search provider when a later contribution rolls back', () => {
    const { h, search, textExtensions } = host()
    textExtensions.set('rgthree.text.complete', { id: 'rgthree.text.complete' })
    let changes = 0
    search.subscribe(() => changes++)
    const out = h.register(manifest({ contributions: [
      { id: 'rgthree.search.demo', category: 'searchProvider' },
      { id: 'rgthree.text.complete', category: 'textEditorExtension' },
    ] }), (api) => {
      api.searchProvider('rgthree.search.demo', {
        id: 'rgthree.search.demo', label: 'Demo', priority: 1, query: () => [],
      })
      api.textEditorExtension('rgthree.text.complete', { id: 'rgthree.text.complete' })
    })
    expect(out.map((problem) => problem.code)).toEqual(['extension.contribution-conflict', 'extension.rollback-complete'])
    expect(search.list()).toEqual([])
    expect(changes).toBe(0)
  })

  it('publishes multi-provider gates and pack teardown only after every slot settles', () => {
    const { h, search } = host()
    const calls: string[] = []
    expect(h.register(manifest({ contributions: [
      { id: 'rgthree.search.first', category: 'searchProvider' },
      { id: 'rgthree.search.second', category: 'searchProvider' },
    ] }), (api) => {
      api.searchProvider('rgthree.search.first', {
        id: 'rgthree.search.first', label: 'First', priority: 2,
        query: () => { calls.push('first'); return [] },
      })
      api.searchProvider('rgthree.search.second', {
        id: 'rgthree.search.second', label: 'Second', priority: 1,
        query: () => { calls.push('second'); return [] },
      })
    })).toEqual([])

    const snapshots: string[][] = []
    search.subscribe(() => snapshots.push(search.list().map((provider) => provider.id)))
    const session = createSearchSession({
      registry: search,
      context: () => ({ selection: { nodes: [] } }),
      onGroups() {},
    })
    session.query('')
    calls.length = 0

    h.setPackEnabled('rgthree', false)
    expect(snapshots).toEqual([[]])
    expect(calls).toEqual([])

    snapshots.length = 0
    h.setPackEnabled('rgthree', true)
    expect(snapshots).toEqual([['rgthree.search.first', 'rgthree.search.second']])
    expect(calls).toEqual(['first', 'second'])

    snapshots.length = 0
    calls.length = 0
    h.unregister('rgthree')
    expect(snapshots).toEqual([[]])
    expect(calls).toEqual([])
    session.dispose()
  })

  it('publishes host disposal only after every pack is inactive', () => {
    const { h, search } = host()
    const calls: string[] = []
    for (const packId of ['first', 'second']) {
      const providerId = `${packId}.search.demo`
      expect(h.register({ id: packId, contributions: [{ id: providerId, category: 'searchProvider' }] }, (api) => {
        api.searchProvider(providerId, {
          id: providerId, label: packId, priority: 1,
          query: () => { calls.push(packId); return [] },
        })
      })).toEqual([])
    }

    const snapshots: string[][] = []
    search.subscribe(() => snapshots.push(search.list().map((provider) => provider.id)))
    const session = createSearchSession({
      registry: search,
      context: () => ({ selection: { nodes: [] } }),
      onGroups() {},
    })
    session.query('')
    calls.length = 0

    h.dispose()
    expect(snapshots).toEqual([[]])
    expect(calls).toEqual([])
    expect(h.packs()).toEqual([])
    session.dispose()
  })

  it('publishes a committed reentrant gate change when an outer activation rolls back', async () => {
    const { h, search, textExtensions } = host()
    let pendingSignal: AbortSignal | undefined
    let resolvePending: ((results: readonly SearchResult[]) => void) | undefined
    expect(h.register(manifest({ id: 'active', contributions: [
      { id: 'active.search.demo', category: 'searchProvider' },
    ] }), (api) => {
      api.searchProvider('active.search.demo', {
        id: 'active.search.demo', label: 'Active', priority: 1,
        query: (_query, context) => {
          pendingSignal = context.signal
          return new Promise((resolve) => { resolvePending = resolve })
        },
      })
    })).toEqual([])

    let latest: readonly string[] = []
    const session = createSearchSession({
      registry: search,
      context: () => ({ selection: { nodes: [] } }),
      onGroups: (groups) => { latest = groups.map((group) => `${group.id}:${group.status}`) },
    })
    session.query('open')
    expect(latest).toEqual(['active.search.demo:loading'])
    const snapshots: string[][] = []
    search.subscribe(() => snapshots.push(search.list().map((provider) => provider.id)))

    textExtensions.set('failing.text.demo', { id: 'failing.text.demo' })
    const out = h.register(manifest({ id: 'failing', contributions: [
      { id: 'failing.search.demo', category: 'searchProvider' },
      { id: 'failing.text.demo', category: 'textEditorExtension' },
    ] }), (api) => {
      api.onDispose(() => h.setPackEnabled('active', false))
      api.searchProvider('failing.search.demo', {
        id: 'failing.search.demo', label: 'Failing', priority: 1, query: () => [],
      })
      api.textEditorExtension('failing.text.demo', { id: 'failing.text.demo' })
    })

    expect(out.map((problem) => problem.code)).toEqual(['extension.contribution-conflict', 'extension.rollback-complete'])
    expect(search.list()).toEqual([])
    expect(snapshots).toEqual([[]])
    expect(pendingSignal?.aborted).toBe(true)
    expect(latest).toEqual([])
    resolvePending?.([{
      id: 'stale', title: 'Stale', score: 1,
      action: { kind: 'host', action: 'settings.open', params: { category: 'test' } },
    }])
    await Promise.resolve()
    await Promise.resolve()
    expect(latest).toEqual([])
    expect(h.packs().map((pack) => [pack.manifest.id, pack.enabled, pack.registered])).toEqual([
      ['active', false, true],
      ['failing', true, false],
    ])
    session.dispose()
  })

  it('rolls back a reload when a text editor extension identity is occupied', () => {
    const { h, menus, textExtensions } = host()
    const occupied = { id: 'rgthree.text.complete' }
    textExtensions.set(occupied.id, occupied)
    const out = h.register(manifest({ contributions: [
      { id: 'rgthree.menu.muter', category: 'menu' },
      { id: 'rgthree.text.complete', category: 'textEditorExtension' },
    ] }), (api) => {
      api.menu('rgthree.menu.muter', menuContribution('rgthree.menu.muter'))
      api.textEditorExtension('rgthree.text.complete', { id: 'rgthree.text.complete' })
    })
    expect(out.map((problem) => problem.code)).toEqual([
      'extension.contribution-conflict',
      'extension.rollback-complete',
    ])
    expect(menus.resolve(nodeCtx)).toEqual([])
    expect(textExtensions.get(occupied.id)).toBe(occupied)
    expect(h.packs()[0]).toMatchObject({ registered: false, active: false })
  })

  it('refuses undeclared, mismatched, and doubled contributions with diagnostics', () => {
    const { h, menus, widgets } = host()
    const out = h.register(manifest(), (api) => {
      api.menu('rgthree.menu.ghost', menuContribution('rgthree.menu.ghost')) // undeclared
      api.widgetKind('rgthree.menu.muter', widgetKind('rgthree.menu.muter')) // declared as menu, not widgetKind
      api.menu('rgthree.menu.muter', menuContribution('rgthree.other.id')) // payload id mismatch
      api.menu('rgthree.menu.muter', menuContribution('rgthree.menu.muter'))
      api.menu('rgthree.menu.muter', menuContribution('rgthree.menu.muter')) // twice
    })
    expect(out.map((d) => d.code)).toEqual([
      'extension.contribution-undeclared',
      'extension.contribution-undeclared',
      'extension.contribution-id-mismatch',
      'extension.contribution-twice',
      'extension.rollback-complete',
    ])
    // One invalid declaration rejects the transaction; no valid sibling leaks.
    expect(menus.resolve(nodeCtx)).toEqual([])
    expect(widgets.kind('rgthree.menu.muter')).toBeUndefined()
    expect(h.packs()[0]).toMatchObject({ registered: false, active: false })
  })

  it('refuses manifests with errors wholesale (activate never runs) and duplicate packs', () => {
    const { h } = host()
    let ran = false
    const out = h.register(manifest({ id: 'core' }), () => {
      ran = true
    })
    expect(out.some((d) => d.code === 'extension.pack-id-reserved')).toBe(true)
    expect(ran).toBe(false)
    expect(installPack(h)).toEqual([])
    expect(h.register(manifest(), () => {}).map((d) => d.code)).toContain('extension.pack-duplicate')
  })

  it('activation throw aborts and rolls back every staged contribution and disposer', () => {
    const { h, menus } = host()
    const order: string[] = []
    const out = h.register(manifest(), (api) => {
      api.onDispose(() => order.push(`dispose:${api.signal.aborted}`))
      api.menu('rgthree.menu.muter', menuContribution('rgthree.menu.muter'))
      throw new Error('pack bug')
    })
    expect(out.map((d) => d.code)).toEqual(['extension.activate-failed', 'extension.rollback-complete'])
    expect(menus.resolve(nodeCtx)).toEqual([])
    expect(h.packs()[0]).toMatchObject({ registered: false, active: false })
    expect(order).toEqual(['dispose:true'])
  })

  it('requires every admitted snapshot contribution before committing', () => {
    const { h, menus } = host()
    const out = h.register(manifest(), (api) => {
      api.menu('rgthree.menu.muter', menuContribution('rgthree.menu.muter'))
    }, true)
    expect(out.map((d) => d.code)).toEqual(['extension.contribution-missing', 'extension.rollback-complete'])
    expect(menus.resolve(nodeCtx)).toEqual([])
    expect(h.packs()[0]).toMatchObject({ registered: false, active: false })
  })

  it('unregister aborts and disposes resources in LIFO order', () => {
    const { h } = host()
    const order: string[] = []
    h.register(manifest(), (api) => {
      api.onDispose(() => order.push(`first:${api.signal.aborted}`))
      api.onDispose(() => order.push(`second:${api.signal.aborted}`))
    })
    h.unregister('rgthree')
    h.unregister('rgthree')
    expect(order).toEqual(['second:true', 'first:true'])
    expect(h.packs()).toEqual([])
  })

  it('continues deactivation after unregister and disposer failures', () => {
    const events: string[] = []
    const h = new ExtensionHost({
      menus: createMenuRegistry(), widgets: fakeWidgets(),
      registerSetting: () => () => { events.push('unregister-setting'); throw new Error('unregister failed') },
      registerCommand: () => () => events.push('unregister-command'),
    })
    const out = h.register({ id: 'cleanup', contributions: [
      { id: 'cleanup.setting', category: 'setting' },
      { id: 'cleanup.command', category: 'command' },
    ] }, (api) => {
      api.setting('cleanup.setting', { id: 'cleanup.setting', name: 'Setting', type: 'boolean', defaultValue: false })
      api.command('cleanup.command', { id: 'cleanup.command', label: 'Command', run() {} })
      api.onDispose(() => { events.push(`dispose-first:${api.signal.aborted}`) })
      api.onDispose(() => { events.push(`dispose-second:${api.signal.aborted}`); throw new Error('dispose failed') })
    })
    expect(out).toEqual([])
    h.unregister('cleanup')
    expect(events).toEqual(['unregister-command', 'unregister-setting', 'dispose-second:true', 'dispose-first:true'])
    expect(h.packs()).toEqual([])
  })

  it('closes the activation API after activate returns', () => {
    const { h } = host()
    let captured: Parameters<Parameters<ExtensionHost['register']>[1]>[0] | undefined
    expect(h.register(manifest(), (api) => { captured = api })).toEqual([])
    expect(() => captured!.onDispose(() => {})).toThrow('activation scope is closed')
    expect(() => captured!.menu('rgthree.menu.muter', menuContribution('rgthree.menu.muter'))).toThrow('activation scope is closed')
  })

  it("missing 'uses' providers warn by name; present providers stay silent", () => {
    const { h, widgets } = host()
    widgets.registerKind(widgetKind('kj.curve'))
    const out = h.register(manifest({ uses: ['kj.curve', 'kj.spline'] }), () => {})
    expect(out).toHaveLength(1)
    expect(out[0]!.severity).toBe('warning')
    expect(out[0]!.code).toBe('extension.uses-missing')
    expect(out[0]!.message).toContain('kj.spline')
  })
})

describe('gating', () => {
  it('pack gate: disabling unregisters everything; re-enabling restores it', () => {
    const { h, menus, widgets, gateLog } = host()
    installPack(h)
    h.setPackEnabled('rgthree', false)
    expect(menus.resolve(nodeCtx)).toEqual([])
    expect(widgets.kind('rgthree.widget.power')).toBeUndefined()
    h.setPackEnabled('rgthree', true)
    expect(menus.resolve(nodeCtx).flatMap((g) => g.items.map((i) => i.id))).toEqual(['rgthree.menu.muter.item'])
    expect(widgets.kind('rgthree.widget.power')).toBeDefined()
    expect(gateLog).toHaveLength(2) // persistence hook saw both flips
  })

  it('category gate: all menus off, widgets untouched', () => {
    const { h, menus, widgets } = host()
    installPack(h)
    h.setCategoryEnabled('rgthree', 'menu', false)
    expect(menus.resolve(nodeCtx)).toEqual([])
    expect(widgets.kind('rgthree.widget.power')).toBeDefined()
  })

  it('contribution gate: one feature off, siblings untouched', () => {
    const { h, menus, widgets } = host()
    installPack(h)
    h.setContributionEnabled('rgthree.widget.power', false)
    expect(widgets.kind('rgthree.widget.power')).toBeUndefined()
    expect(menus.resolve(nodeCtx).flatMap((g) => g.items.map((i) => i.id))).toEqual(['rgthree.menu.muter.item'])
  })

  it('initial gates apply before activation registers anything', () => {
    const { h, menus } = host({
      gates: { packs: {}, categories: {}, contributions: { 'rgthree.menu.muter': false } },
    })
    installPack(h)
    expect(menus.resolve(nodeCtx)).toEqual([])
  })

  it('gate flips are idempotent and never double-register', () => {
    const { h, menus } = host()
    installPack(h)
    h.setPackEnabled('rgthree', true) // already on: no-op
    h.setContributionEnabled('rgthree.menu.muter', true)
    expect(menus.resolve(nodeCtx).flatMap((g) => g.items.map((i) => i.id))).toEqual(['rgthree.menu.muter.item'])
  })

  it('clears a registration failure after a gate retry succeeds', () => {
    const { h, widgets } = host()
    installPack(h)
    h.setContributionEnabled('rgthree.widget.power', false)
    const releaseIdentity = widgets.registerKind(widgetKind('rgthree.widget.power'))

    h.setContributionEnabled('rgthree.widget.power', true)
    expect(h.packs()[0]!.contributions.find((status) => status.decl.id === 'rgthree.widget.power')).toMatchObject({
      active: false,
      state: 'failed',
    })

    releaseIdentity()
    h.setContributionEnabled('rgthree.widget.power', true)
    expect(h.packs()[0]!.contributions.find((status) => status.decl.id === 'rgthree.widget.power')).toMatchObject({
      active: true,
      state: 'active',
    })
    expect(h.packs()[0]!.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('extension.contribution-conflict')
  })

  it('clears every distinct registration failure after a gate retry succeeds', () => {
    let attempts = 0
    let live = false
    const h = new ExtensionHost({
      menus: createMenuRegistry(),
      widgets: fakeWidgets(),
      registerSetting: () => {
        attempts++
        if (attempts === 2) throw new Error('first refusal')
        if (attempts === 3) throw new Error('second refusal')
        live = true
        return () => { live = false }
      },
    })
    h.register(manifest({
      id: 'retry-pack',
      contributions: [{ id: 'retry-pack.setting.demo', category: 'setting' }],
    }), (api) => api.setting('retry-pack.setting.demo', {
      id: 'retry-pack.setting.demo', name: 'Retry setting', type: 'boolean', defaultValue: true,
    }))

    h.setContributionEnabled('retry-pack.setting.demo', false)
    h.setContributionEnabled('retry-pack.setting.demo', true)
    h.setContributionEnabled('retry-pack.setting.demo', true)
    expect(h.packs()[0]!.diagnostics.filter((diagnostic) => diagnostic.code === 'extension.contribution-conflict')).toHaveLength(2)

    h.setContributionEnabled('retry-pack.setting.demo', true)
    expect(live).toBe(true)
    expect(h.packs()[0]!.contributions[0]).toMatchObject({ active: true, state: 'active' })
    expect(h.packs()[0]!.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('extension.contribution-conflict')
  })
})

describe('deployment policy', () => {
  it('deny is hard-off: user gates cannot re-enable', () => {
    const { h, widgets } = host({ policy: { deny: ['rgthree.widget.power'] } })
    installPack(h)
    expect(widgets.kind('rgthree.widget.power')).toBeUndefined()
    h.setContributionEnabled('rgthree.widget.power', true)
    expect(widgets.kind('rgthree.widget.power')).toBeUndefined()
    const status = h.packs()[0]!.contributions.find((c) => c.decl.id === 'rgthree.widget.power')!
    expect(status.policyBlocked).toBe(true)
    expect(status.active).toBe(false)
  })

  it('deny at category and pack granularity', () => {
    const a = host({ policy: { deny: ['rgthree/menu'] } })
    installPack(a.h)
    expect(a.menus.resolve(nodeCtx)).toEqual([])
    expect(a.widgets.kind('rgthree.widget.power')).toBeDefined()

    const b = host({ policy: { deny: ['rgthree'] } })
    installPack(b.h)
    expect(b.menus.resolve(nodeCtx)).toEqual([])
    expect(b.widgets.kind('rgthree.widget.power')).toBeUndefined()
  })

  it('nonempty allow list admits only what it names', () => {
    const { h, menus, widgets } = host({ policy: { allow: ['rgthree/menu'] } })
    installPack(h)
    expect(menus.resolve(nodeCtx).flatMap((g) => g.items.map((i) => i.id))).toEqual(['rgthree.menu.muter.item'])
    expect(widgets.kind('rgthree.widget.power')).toBeUndefined()
  })

  it('presents ancestors as operable when an allow rule admits a descendant', () => {
    const { h } = host({ policy: { allow: ['rgthree.menu.muter'] } })
    installPack(h)
    const [pack] = h.packs()
    const menu = pack!.categories.find((category) => category.category === 'menu')!
    const widgets = pack!.categories.find((category) => category.category === 'widgetKind')!

    expect(pack).toMatchObject({ policyBlocked: false })
    expect(pack!.policyReason).toBeUndefined()
    expect(menu).toMatchObject({ policyBlocked: false })
    expect(menu.policyReason).toBeUndefined()
    expect(menu.contributions[0]).toMatchObject({ policyBlocked: false, active: true })
    expect(widgets).toMatchObject({ policyBlocked: true })
    expect(widgets.contributions[0]).toMatchObject({ policyBlocked: true, active: false })
  })
})

describe('registry identity conflicts', () => {
  it('a taken identity rolls back the whole initial registry commit', () => {
    const { h, menus, widgets } = host()
    const freeIdentity = widgets.registerKind(widgetKind('rgthree.widget.power')) // direct registrant got there first
    const out = installPack(h)
    expect(out.map((d) => d.code)).toEqual(['extension.contribution-conflict', 'extension.rollback-complete'])
    expect(out[0]!.message).toContain('rgthree.widget.power')
    expect(menus.resolve(nodeCtx)).toEqual([])
    expect(h.packs()[0]).toMatchObject({ registered: false, active: false })
    freeIdentity()
    expect(installPack(h)).toEqual([])
    expect(widgets.kind('rgthree.widget.power')).toBeDefined()
    expect(h.packs()).toHaveLength(1)
    expect(h.packs()[0]).toMatchObject({ registered: true, active: true })
  })
})

describe('introspection', () => {
  it('packs() reports declaration, contribution, and active state', () => {
    const { h } = host()
    h.register(manifest(), (api) => {
      api.menu('rgthree.menu.muter', menuContribution('rgthree.menu.muter'))
      // rgthree.widget.power declared but never contributed: inert, visible.
    })
    const [pack] = h.packs()
    expect(pack!.enabled).toBe(true)
    const byId = Object.fromEntries(pack!.contributions.map((c) => [c.decl.id, c]))
    expect(byId['rgthree.menu.muter']).toMatchObject({ contributed: true, active: true })
    expect(byId['rgthree.widget.power']).toMatchObject({ contributed: false, active: false })
  })

  it('reports category gates, exact policy cause, and failed activation without live registrations', () => {
    const { h, menus } = host({ policy: { deny: ['rgthree/menu'] } })
    h.setCategoryEnabled('rgthree', 'widgetKind', false)
    h.register(manifest(), (api) => {
      api.menu('rgthree.menu.muter', menuContribution('rgthree.menu.muter'))
      throw new Error('fixture activation failed')
    })

    const [pack] = h.packs()
    expect(pack).toMatchObject({ registered: false, active: false, enabled: true })
    expect(pack!.categories).toEqual([
      expect.objectContaining({
        category: 'menu', enabled: true, policyBlocked: true,
        policyReason: "Blocked by deployment deny rule 'rgthree/menu'.",
      }),
      expect.objectContaining({ category: 'widgetKind', enabled: false, policyBlocked: false }),
    ])
    expect(pack!.contributions.map((contribution) => contribution.state)).toEqual(['failed', 'unregistered'])
    expect(pack!.diagnostics.map((problem) => problem.code)).toEqual(['extension.activate-failed', 'extension.rollback-complete'])
    expect(menus.resolve(nodeCtx)).toEqual([])

    h.unregister('rgthree')
    expect(h.packs()).toEqual([])
  })

  it('changed signal bumps on install and on every gate change', () => {
    const { h } = host()
    let bumps = 0
    h.changed.subscribe(() => bumps++)
    installPack(h)
    h.setPackEnabled('rgthree', false)
    expect(bumps).toBe(2)
  })
})
