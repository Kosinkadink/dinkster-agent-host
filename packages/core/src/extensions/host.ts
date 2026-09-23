/**
 * ExtensionHost: activates pack manifests against the typed registries and
 * owns per-contribution gating (architecture section 11).
 *
 * The gating model is structural, not trust-based:
 * - a pack's activate callback may contribute ONLY what its manifest
 *   declared, keyed by the declared id - nothing implicit, so the host
 *   knows every feature before pack code runs;
 * - the host holds the contributed payloads and registers/unregisters them
 *   as gates flip - a disabled contribution is OUT of its registry, and
 *   since there is no raw DOM/canvas escape hatch it has no path back in;
 * - enable state has three granularities (whole pack, category within a
 *   pack, individual contribution) plus a host DEPLOYMENT POLICY
 *   (allowlist/denylist) that user settings can never override - the
 *   embedding-host case (cloud) that the old ecosystem could not express;
 * - nodes and frontend features are independent axes: nothing here touches
 *   schemas, so disabling a pack's UI never blocks its nodes.
 */

import { diag, type Diagnostic } from '../diagnostics.js'
import type { MenuContribution, MenuRegistry } from '../menus/contract.js'
import { createSignal, type ReadonlySignal, type Signal } from '../reactive/signal.js'
import type { Json } from '../format/document.js'
import type { ExtensionEvent } from '../events/contract.js'
import { ownExtensionSearchProvider, type SearchProvider } from '../search/contract.js'
import { HOST_UI_MAX_VISIBLE_STRING_LENGTH, type HostUiProviderV1 } from '../ui/contribution.js'
import type { PreviewRenderer, WidgetKind, WidgetRegistry, WidgetView } from '../widgets/contract.js'
import type { VirtualNodeKind } from '../virtual-node.js'
import {
  validateManifest,
  type ContributionCategory,
  type ContributionDecl,
  type PackManifest,
} from './manifest.js'

// ---------------------------------------------------------------------------
// Gates and policy
// ---------------------------------------------------------------------------

/**
 * Explicit gate overrides; anything absent is enabled. Category keys are
 * '<packId>/<category>'. Plain data, so hosts persist it verbatim.
 */
export interface GateState {
  readonly packs: Readonly<Record<string, boolean>>
  readonly categories: Readonly<Record<string, boolean>>
  readonly contributions: Readonly<Record<string, boolean>>
}

export const emptyGates: GateState = { packs: {}, categories: {}, contributions: {} }

/**
 * Host-level allow/deny over pack ids, '<packId>/<category>' keys, and
 * contribution ids. Deny always wins; a nonempty allow list admits only
 * what it names (at any granularity). Policy-blocked contributions are
 * hard-off: user gates cannot re-enable them.
 */
export interface DeploymentPolicy {
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
}

interface PolicyDecision {
  readonly allowed: boolean
  readonly reason?: string
}

function policyDecision(policy: DeploymentPolicy | undefined, keys: readonly string[]): PolicyDecision {
  if (!policy) return { allowed: true }
  const deniedBy = policy.deny?.find((entry) => keys.includes(entry))
  if (deniedBy !== undefined) {
    return { allowed: false, reason: `Blocked by deployment deny rule '${deniedBy}'.` }
  }
  if (policy.allow && policy.allow.length > 0 && !policy.allow.some((entry) => keys.includes(entry))) {
    return {
      allowed: false,
      reason: `Blocked because no deployment allow rule matches ${keys.map((key) => `'${key}'`).join(', ')}.`,
    }
  }
  return { allowed: true }
}

// ---------------------------------------------------------------------------
// Activation API
// ---------------------------------------------------------------------------

/**
 * What an activating pack receives: one contribute door per category, each
 * keyed by a DECLARED contribution id. Contributing an undeclared id, a
 * category-mismatched id, or a payload whose own id disagrees with the
 * declaration is refused with a diagnostic (manifest-first, no implicit
 * contributions). Values in, commands out - no core internals cross here.
 */
export interface ExtensionIdentity {
  readonly id: string
}

export interface ExtensionEditorKind extends ExtensionIdentity {
  readonly title: string
  readonly provider: HostUiProviderV1
}

export interface EditorBindingMatch {
  readonly editorRole?: string
  readonly nodeId?: string
  readonly widgetType?: string
  readonly valueType?: string
}

export interface EditorBinding extends ExtensionIdentity {
  readonly editor: string
  readonly match: EditorBindingMatch
  readonly priority?: number
}

export type ExtensionPanelSlot = 'sidebar.left' | 'sidebar.right' | 'panel.bottom' | 'toolbar.canvas'
export interface ExtensionPanelContributionV1 extends ExtensionIdentity {
  readonly slot: ExtensionPanelSlot
  readonly provider: HostUiProviderV1
  readonly order?: number
  readonly title?: string
}

export interface CanvasLayerNode {
  readonly id: string
  readonly type: string
  readonly title: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface CanvasLayerContext {
  readonly context: CanvasRenderingContext2D
  readonly viewport: Readonly<{ x: number; y: number; width: number; height: number; scale: number }>
  readonly nodes: readonly CanvasLayerNode[]
}

export interface CanvasLayerContribution extends ExtensionIdentity {
  readonly position: 'background' | 'foreground'
  readonly order?: number
  readonly draw: (context: CanvasLayerContext) => void
}

export interface PackActivationApi<TTextEditorExtension extends ExtensionIdentity = ExtensionIdentity> {
  /** Aborted before rollback/deactivation disposers run. */
  readonly signal: AbortSignal
  onDispose(disposer: () => void): void
  menu(id: string, contribution: MenuContribution): void
  widgetKind(id: string, kind: WidgetKind): void
  widgetView(id: string, view: WidgetView): void
  previewRenderer(id: string, renderer: PreviewRenderer): void
  textEditorExtension(id: string, extension: TTextEditorExtension): void
  setting(id: string, setting: ExtensionSetting): void
  command(id: string, command: ExtensionCommand): void
  keybinding(id: string, keybinding: ExtensionKeybinding): void
  hostUi(id: string, slot: ExtensionHostUiSlot, provider: HostUiProviderV1, order?: number, title?: string): void
  searchProvider(id: string, provider: SearchProvider): void
  eventConsumer(id: string, consume: (event: ExtensionEvent) => void): void
  editor(id: string, kind: ExtensionEditorKind): void
  editorBinding(id: string, binding: EditorBinding): void
  panel(id: string, slot: ExtensionPanelSlot, provider: HostUiProviderV1, order?: number, title?: string): void
  virtualNode(id: string, kind: VirtualNodeKind): void
  canvasLayer(id: string, layer: CanvasLayerContribution): void
}

/** App-shell contributions stay structural here so core never depends on Solid. */
export interface ExtensionSetting {
  readonly id: string; readonly name: string; readonly category?: string; readonly type: string
  readonly defaultValue: unknown; readonly description?: string; readonly options?: readonly { value: string; label: string }[]
  readonly min?: number; readonly max?: number; readonly step?: number
}
export interface ExtensionCommand { readonly id: string; readonly label: string; readonly run: (payload?: Json) => void }
export interface ExtensionKeybinding { readonly command: string; readonly combo: string; readonly allowInInput?: boolean }
/** The initial contract exposes only the shell slot the host renders. */
export type ExtensionHostUiSlot = 'status.trailing'
export interface ExtensionHostUiContributionV1 {
  readonly id: string
  readonly slot: ExtensionHostUiSlot
  readonly order?: number
  readonly title?: string
  readonly provider: HostUiProviderV1
}

// ---------------------------------------------------------------------------
// Snapshot for the gating UI
// ---------------------------------------------------------------------------

export interface ContributionStatus {
  readonly decl: ContributionDecl
  /** The pack actually contributed a payload for this declaration. */
  readonly contributed: boolean
  /** All gates open AND policy allows: the payload is in its registry now. */
  readonly active: boolean
  /** Hard-off by deployment policy; user gates cannot change it. */
  readonly policyBlocked: boolean
  readonly policyReason?: string
  /** This contribution's own gate (pack/category gates are separate). */
  readonly enabled: boolean
  readonly state: 'active' | 'inactive' | 'unregistered' | 'failed'
}

export interface CategoryStatus {
  readonly category: ContributionCategory
  readonly enabled: boolean
  readonly policyBlocked: boolean
  readonly policyReason?: string
  readonly contributions: readonly ContributionStatus[]
}

export interface PackStatus {
  readonly manifest: PackManifest
  /** Whether activation committed and the pack is owned by the live host. */
  readonly registered: boolean
  readonly active: boolean
  readonly enabled: boolean
  readonly policyBlocked: boolean
  readonly policyReason?: string
  readonly contributions: readonly ContributionStatus[]
  readonly categories: readonly CategoryStatus[]
  /** Manifest/activation problems, including missing 'uses' providers. */
  readonly diagnostics: readonly Diagnostic[]
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

interface Slot<TTextEditorExtension extends ExtensionIdentity> {
  readonly packId: string
  readonly decl: ContributionDecl
  payload?:
    | { readonly category: 'menu'; readonly value: MenuContribution }
    | { readonly category: 'widgetKind'; readonly value: WidgetKind }
    | { readonly category: 'widgetView'; readonly value: WidgetView }
    | { readonly category: 'previewRenderer'; readonly value: PreviewRenderer }
    | { readonly category: 'textEditorExtension'; readonly value: TTextEditorExtension }
    | { readonly category: 'setting'; readonly value: ExtensionSetting }
    | { readonly category: 'command'; readonly value: ExtensionCommand }
    | { readonly category: 'keybinding'; readonly value: ExtensionKeybinding }
    | { readonly category: 'hostUi'; readonly value: ExtensionHostUiContributionV1 }
    | { readonly category: 'searchProvider'; readonly value: SearchProvider }
    | { readonly category: 'eventConsumer'; readonly value: (event: ExtensionEvent) => void }
    | { readonly category: 'editor'; readonly value: ExtensionEditorKind }
    | { readonly category: 'editorBinding'; readonly value: EditorBinding }
    | { readonly category: 'panel'; readonly value: ExtensionPanelContributionV1 }
    | { readonly category: 'virtualNode'; readonly value: VirtualNodeKind }
    | { readonly category: 'canvasLayer'; readonly value: CanvasLayerContribution }
  /** Set while the payload is registered; calling it removes it. */
  unregister?: (() => void) | undefined
}

interface InstalledPack<TTextEditorExtension extends ExtensionIdentity> {
  readonly manifest: PackManifest
  readonly slots: Map<string, Slot<TTextEditorExtension>>
  readonly diagnostics: Diagnostic[]
  readonly controller: AbortController
  readonly disposers: (() => void)[]
}

interface FailedPackPresentation {
  readonly manifest: PackManifest
  readonly diagnostics: readonly Diagnostic[]
  readonly contributedIds: ReadonlySet<string>
}

export interface ExtensionHostOptions<TTextEditorExtension extends ExtensionIdentity = ExtensionIdentity> {
  readonly menus: MenuRegistry
  readonly widgets: WidgetRegistry
  /** Shared presentation revision for a root and its connection worlds. */
  readonly changedSignal?: Signal<number>
  readonly registerTextEditorExtension?: (extension: TTextEditorExtension) => () => void
  readonly registerSetting?: (setting: ExtensionSetting) => () => void
  readonly registerCommand?: (command: ExtensionCommand) => () => void
  readonly registerKeybinding?: (keybinding: ExtensionKeybinding) => () => void
  readonly registerHostUi?: (id: string, slot: ExtensionHostUiSlot, provider: HostUiProviderV1, order?: number, title?: string) => () => void
  readonly invalidateHostUi?: (id: string) => void
  readonly registerSearchProvider?: (provider: SearchProvider) => () => void
  readonly registerEventConsumer?: (id: string, consume: (event: ExtensionEvent) => void) => () => void
  readonly registerEditor?: (kind: ExtensionEditorKind) => () => void
  readonly registerEditorBinding?: (binding: EditorBinding) => () => void
  readonly registerPanel?: (panel: ExtensionPanelContributionV1) => () => void
  readonly registerVirtualNode?: (kind: VirtualNodeKind) => () => void
  readonly registerCanvasLayer?: (layer: CanvasLayerContribution) => () => void
  /** Suppress registry change publication until the initial pack commit settles. */
  readonly beginRegistryBatch?: () => (commit: boolean) => void
  readonly policy?: DeploymentPolicy
  readonly initialGates?: GateState
  /** Called with the full gate state after every user-facing gate change. */
  readonly onGatesChanged?: (gates: GateState) => void
}

export class ExtensionHost<TTextEditorExtension extends ExtensionIdentity = ExtensionIdentity> {
  private readonly menus: MenuRegistry
  private readonly widgets: WidgetRegistry
  private readonly options: ExtensionHostOptions<TTextEditorExtension>
  private readonly policy: DeploymentPolicy | undefined
  private readonly onGatesChanged: ((gates: GateState) => void) | undefined
  private readonly installed = new Map<string, InstalledPack<TTextEditorExtension>>()
  private readonly failed = new Map<string, FailedPackPresentation>()
  private readonly presentationOrder = new Set<string>()
  private gatesState: GateState
  private readonly changedSignal: Signal<number>

  constructor(options: ExtensionHostOptions<TTextEditorExtension>) {
    this.changedSignal = options.changedSignal ?? createSignal(0)
    this.options = options
    this.menus = options.menus
    this.widgets = options.widgets
    this.policy = options.policy
    this.onGatesChanged = options.onGatesChanged
    this.gatesState = options.initialGates ?? emptyGates
  }

  /** Bumped on every install and gate change; UIs subscribe to this. */
  get changed(): ReadonlySignal<number> {
    return this.changedSignal
  }

  /** Current explicit gate overrides (persist verbatim). */
  get gates(): GateState {
    return this.gatesState
  }

  /** The same admission check applies before imports and during registration. */
  contributionEnabled(packId: string, decl: ContributionDecl): boolean {
    return policyDecision(this.policy, [packId, `${packId}/${decl.category}`, decl.id]).allowed &&
      this.gatesState.packs[packId] !== false &&
      this.gatesState.categories[`${packId}/${decl.category}`] !== false &&
      this.gatesState.contributions[decl.id] !== false
  }

  /**
   * Install a pack: validate the manifest, run its activate callback, and
   * register whatever open gates admit. Returns diagnostics; ERROR-severity
   * manifest problems refuse the whole pack (activate never runs). Activation
   * and initial registry publication are transactional: any error aborts and
   * disposes staging in LIFO order, and no contribution becomes observable.
   */
  register(manifest: PackManifest, activate: (api: PackActivationApi<TTextEditorExtension>) => void, requireContributions: boolean | ReadonlySet<string> = false): readonly Diagnostic[] {
    const problems = [...validateManifest(manifest)]
    if (this.installed.has(manifest.id)) {
      problems.push(diag('error', 'extension', 'extension.pack-duplicate', `pack '${manifest.id}' already installed`))
    }
    if (problems.some((p) => p.severity === 'error')) return problems

    // Declared dependencies: absent providers degrade gracefully with a
    // diagnostic NAMING the provider - never a hard failure.
    for (const use of manifest.uses ?? []) {
      if (this.widgets.kind(use) === undefined) {
        problems.push(
          diag(
            'warning',
            'extension',
            'extension.uses-missing',
            `pack '${manifest.id}' uses widget kind '${use}', which no installed pack provides`,
          ),
        )
      }
    }

    const pack: InstalledPack<TTextEditorExtension> = {
      manifest,
      slots: new Map(),
      diagnostics: problems,
      controller: new AbortController(),
      disposers: [],
    }
    for (const decl of manifest.contributions) pack.slots.set(decl.id, { packId: manifest.id, decl })
    let activationOpen = true

    const accept = <C extends ContributionCategory>(
      id: string,
      category: C,
      payloadId: string | undefined,
      store: () => void,
    ): void => {
      if (!activationOpen) throw new Error(`pack '${manifest.id}' activation scope is closed`)
      const slot = pack.slots.get(id)
      if (!slot || slot.decl.category !== category) {
        pack.diagnostics.push(
          diag(
            'error',
            'extension',
            'extension.contribution-undeclared',
            `pack '${manifest.id}' contributed '${id}' as ${category}, which its manifest does not declare`,
          ),
        )
        return
      }
      if (payloadId !== undefined && payloadId !== id) {
        pack.diagnostics.push(
          diag(
            'error',
            'extension',
            'extension.contribution-id-mismatch',
            `contribution '${id}' carries payload id '${payloadId}'; they must be identical`,
          ),
        )
        return
      }
      if (slot.payload) {
        pack.diagnostics.push(
          diag('error', 'extension', 'extension.contribution-twice', `contribution '${id}' provided twice`),
        )
        return
      }
      store()
    }

    const api: PackActivationApi<TTextEditorExtension> = {
      signal: pack.controller.signal,
      canvasLayer: (id, layer) => accept(id, 'canvasLayer', layer.id, () => {
        if (layer.position !== 'background' && layer.position !== 'foreground') {
          throw new Error(`canvas layer '${id}' has an invalid position`)
        }
        if (layer.order !== undefined && (!Number.isFinite(layer.order) || !Number.isInteger(layer.order))) {
          throw new Error(`canvas layer '${id}' has an invalid order`)
        }
        if (typeof layer.draw !== 'function') throw new Error(`canvas layer '${id}' requires a draw callback`)
        pack.slots.get(id)!.payload = {
          category: 'canvasLayer',
          value: Object.freeze({
            id,
            position: layer.position,
            ...(layer.order === undefined ? {} : { order: layer.order }),
            draw: layer.draw,
          }),
        }
      }),
      eventConsumer: (id, consume) => accept(id, 'eventConsumer', undefined, () => {
        if (!this.options.registerEventConsumer) throw new Error('event consumers require a connection snapshot world')
        if (typeof consume !== 'function') throw new Error(`event consumer '${id}' requires a callback`)
        pack.slots.get(id)!.payload = { category: 'eventConsumer', value: consume }
      }),
      editor: (id, kind) => accept(id, 'editor', kind.id, () => {
        if (typeof kind.title !== 'string' || kind.title.length === 0 || typeof kind.provider !== 'function') {
          throw new Error(`editor contribution '${id}' requires a title and provider`)
        }
        pack.slots.get(id)!.payload = {
          category: 'editor', value: Object.freeze({ id, title: kind.title, provider: kind.provider }),
        }
      }),
      editorBinding: (id, binding) => accept(id, 'editorBinding', binding.id, () => {
        const fields = ['editorRole', 'nodeId', 'widgetType', 'valueType'] as const
        if (typeof binding.editor !== 'string' || binding.editor.length === 0 || binding.match === null ||
            typeof binding.match !== 'object' || Object.keys(binding.match).some((key) => !fields.includes(key as typeof fields[number])) ||
            !fields.some((key) => typeof binding.match[key] === 'string' && binding.match[key]!.length > 0) ||
            fields.some((key) => binding.match[key] !== undefined && typeof binding.match[key] !== 'string')) {
          throw new Error(`editor binding '${id}' requires an editor and at least one match field`)
        }
        if (binding.priority !== undefined && (!Number.isFinite(binding.priority) || !Number.isInteger(binding.priority))) {
          throw new Error(`editor binding '${id}' has an invalid priority`)
        }
        const match = Object.freeze(Object.fromEntries(fields.flatMap((key) =>
          binding.match[key] === undefined ? [] : [[key, binding.match[key]]])) as EditorBindingMatch)
        pack.slots.get(id)!.payload = {
          category: 'editorBinding',
          value: Object.freeze({ id, editor: binding.editor, match, ...(binding.priority === undefined ? {} : { priority: binding.priority }) }),
        }
      }),
      panel: (id, slot, provider, order, title) => accept(id, 'panel', id, () => {
        if (!(['sidebar.left', 'sidebar.right', 'panel.bottom', 'toolbar.canvas'] as const).includes(slot)) {
          throw new Error(`panel contribution '${id}' has an invalid slot`)
        }
        if (typeof provider !== 'function') throw new Error(`panel contribution '${id}' requires a provider`)
        if (order !== undefined && (!Number.isFinite(order) || !Number.isInteger(order))) {
          throw new Error(`panel contribution '${id}' has an invalid order`)
        }
        if (title !== undefined && (typeof title !== 'string' || title.length === 0 || title.length > HOST_UI_MAX_VISIBLE_STRING_LENGTH)) {
          throw new Error(`panel contribution '${id}' has an invalid title`)
        }
        pack.slots.get(id)!.payload = {
          category: 'panel',
          value: Object.freeze({ id, slot, provider, ...(order === undefined ? {} : { order }), ...(title === undefined ? {} : { title }) }),
        }
      }),
      virtualNode: (id, kind) => accept(id, 'virtualNode', kind.id, () => {
        if (kind.schema.type !== id || kind.schema.virtual !== true || kind.schema.items.some((item) =>
          item.kind === 'output' || (item.kind === 'input' && (item.widget === undefined || item.forceInput === true)))) {
          throw new Error(`virtual node contribution '${id}' must have a matching port-free schema`)
        }
        pack.slots.get(id)!.payload = { category: 'virtualNode', value: kind }
      }),
      onDispose: (disposer) => {
        if (!activationOpen) throw new Error(`pack '${manifest.id}' activation scope is closed`)
        pack.disposers.push(disposer)
      },
      menu: (id, contribution) =>
        accept(id, 'menu', contribution.id, () => {
          pack.slots.get(id)!.payload = { category: 'menu', value: contribution }
        }),
      widgetKind: (id, kind) =>
        accept(id, 'widgetKind', kind.type, () => {
          pack.slots.get(id)!.payload = { category: 'widgetKind', value: kind }
        }),
      widgetView: (id, view) =>
        accept(id, 'widgetView', view.id, () => {
          pack.slots.get(id)!.payload = { category: 'widgetView', value: view }
        }),
      previewRenderer: (id, renderer) =>
        accept(id, 'previewRenderer', undefined, () => {
          pack.slots.get(id)!.payload = { category: 'previewRenderer', value: renderer }
        }),
      textEditorExtension: (id, extension) =>
        accept(id, 'textEditorExtension', extension.id, () => {
          pack.slots.get(id)!.payload = { category: 'textEditorExtension', value: extension }
        }),
      setting: (id, setting) => accept(id, 'setting', setting.id, () => { pack.slots.get(id)!.payload = { category: 'setting', value: setting } }),
      command: (id, command) => accept(id, 'command', command.id, () => { pack.slots.get(id)!.payload = { category: 'command', value: command } }),
      keybinding: (id, keybinding) => accept(id, 'keybinding', undefined, () => { pack.slots.get(id)!.payload = { category: 'keybinding', value: keybinding } }),
      hostUi: (id, slot, provider, order, title) => accept(id, 'hostUi', id, () => {
        if (slot !== 'status.trailing') throw new Error(`host UI contribution '${id}' has an invalid slot`)
        if (typeof provider !== 'function') throw new Error(`host UI contribution '${id}' requires a provider`)
        if (order !== undefined && (typeof order !== 'number' || !Number.isFinite(order))) throw new Error(`host UI contribution '${id}' has an invalid order`)
        if (title !== undefined && (typeof title !== 'string' || title.length === 0 || title.length > HOST_UI_MAX_VISIBLE_STRING_LENGTH)) {
          throw new Error(`host UI contribution '${id}' has an invalid title`)
        }
        const value = Object.freeze({ id, slot, provider, ...(order === undefined ? {} : { order }), ...(title === undefined ? {} : { title }) })
        pack.slots.get(id)!.payload = { category: 'hostUi', value }
      }),
      searchProvider: (id, provider) => {
        if (!activationOpen) throw new Error(`pack '${manifest.id}' activation scope is closed`)
        const owned = ownExtensionSearchProvider(provider)
        accept(id, 'searchProvider', owned.id, () => {
          pack.slots.get(id)!.payload = { category: 'searchProvider', value: owned }
        })
      },
    }
    try {
      activate(api)
    } catch (e) {
      pack.diagnostics.push(
        diag('error', 'extension', 'extension.activate-failed', `pack '${manifest.id}' activation threw: ${String(e)}`),
      )
    } finally {
      activationOpen = false
    }
    if (requireContributions) {
      for (const slot of pack.slots.values()) {
        if (slot.payload === undefined && (requireContributions === true || requireContributions.has(slot.decl.id))) {
          pack.diagnostics.push(diag('error', 'extension', 'extension.contribution-missing', `contribution '${slot.decl.id}' was not registered`))
        }
      }
    }
    if (pack.diagnostics.some((problem) => problem.severity === 'error')) {
      pack.controller.abort()
      this.disposePackResources(pack)
      pack.diagnostics.push(diag('info', 'extension', 'extension.rollback-complete', `pack '${manifest.id}' activation rolled back with no live contributions`))
      this.rememberFailure(pack)
      this.changedSignal.update((n) => n + 1)
      return pack.diagnostics
    }

    // The pack is temporarily visible only to applyGate's diagnostic lookup;
    // changed is not published until every admitted registration succeeds.
    let committed = false
    this.withRegistryBatch(() => {
      this.installed.set(manifest.id, pack)
      for (const slot of pack.slots.values()) this.applyGate(slot)
      if (pack.diagnostics.some((problem) => problem.severity === 'error')) {
        this.deactivatePack(pack)
        return false
      }
      committed = true
      return true
    })
    if (!committed) {
      pack.diagnostics.push(diag('info', 'extension', 'extension.rollback-complete', `pack '${manifest.id}' registry commit rolled back with no live contributions`))
      this.rememberFailure(pack)
      this.changedSignal.update((n) => n + 1)
      return pack.diagnostics
    }
    this.failed.delete(manifest.id)
    this.presentationOrder.add(manifest.id)
    this.changedSignal.update((n) => n + 1)
    return pack.diagnostics
  }

  /** Deactivate one pack. Idempotent; persisted setting values are untouched. */
  unregister(packId: string): void {
    const pack = this.installed.get(packId)
    if (!pack) {
      if (this.failed.delete(packId)) {
        this.presentationOrder.delete(packId)
        this.changedSignal.update((n) => n + 1)
      }
      return
    }
    this.withRegistryBatch(() => {
      this.deactivatePack(pack)
      return true
    })
    this.presentationOrder.delete(packId)
    this.changedSignal.update((n) => n + 1)
  }

  /** Deactivate every pack in reverse install order. */
  dispose(): void {
    const packs = [...this.installed.values()].reverse()
    const hadPresentations = this.presentationOrder.size > 0
    if (packs.length > 0) {
      this.withRegistryBatch(() => {
        for (const pack of packs) this.deactivatePack(pack)
        return true
      })
    }
    if (!hadPresentations) return
    this.failed.clear()
    this.presentationOrder.clear()
    this.changedSignal.update((n) => n + 1)
  }

  // -- gate switches ----------------------------------------------------------

  setPackEnabled(packId: string, enabled: boolean): void {
    this.setGates({ ...this.gatesState, packs: { ...this.gatesState.packs, [packId]: enabled } })
  }

  setCategoryEnabled(packId: string, category: ContributionCategory, enabled: boolean): void {
    this.setGates({
      ...this.gatesState,
      categories: { ...this.gatesState.categories, [`${packId}/${category}`]: enabled },
    })
  }

  setContributionEnabled(contributionId: string, enabled: boolean): void {
    this.setGates({
      ...this.gatesState,
      contributions: { ...this.gatesState.contributions, [contributionId]: enabled },
    })
  }

  /** Replace the whole gate state (settings import / initial hydration). */
  setGates(gates: GateState): void {
    this.gatesState = gates
    this.withRegistryBatch(() => {
      for (const pack of this.installed.values()) {
        for (const slot of pack.slots.values()) this.applyGate(slot)
      }
      return true
    })
    this.onGatesChanged?.(this.gatesState)
    this.changedSignal.update((n) => n + 1)
  }

  // -- introspection ----------------------------------------------------------

  /** Snapshot for extension management, including transaction failures. */
  packs(): readonly PackStatus[] {
    return [...this.presentationOrder].flatMap((packId): PackStatus[] => {
      const installed = this.installed.get(packId)
      const failed = this.failed.get(packId)
      if (!installed && !failed) return []
      const manifest = installed?.manifest ?? failed!.manifest
      const diagnostics = installed?.diagnostics ?? failed!.diagnostics
      const contributions = manifest.contributions.map((decl): ContributionStatus => {
        const slot = installed?.slots.get(decl.id)
        const contributed = slot?.payload !== undefined || failed?.contributedIds.has(decl.id) === true
        const active = slot?.unregister !== undefined
        const policy = policyDecision(this.policy, [manifest.id, `${manifest.id}/${decl.category}`, decl.id])
        const registrationFailed = diagnostics.some(
          (problem) => problem.code === 'extension.contribution-conflict' && problem.message.includes(`'${decl.id}'`),
        )
        return {
          decl,
          contributed,
          active,
          policyBlocked: !policy.allowed,
          ...(policy.reason === undefined ? {} : { policyReason: policy.reason }),
          enabled: this.gatesState.contributions[decl.id] !== false,
          state: !contributed
            ? 'unregistered'
            : !installed || registrationFailed
              ? 'failed'
              : active
                ? 'active'
                : 'inactive',
        }
      })
      const categories = [...new Set(manifest.contributions.map((decl) => decl.category))].map((category): CategoryStatus => {
        const categoryContributions = contributions.filter((contribution) => contribution.decl.category === category)
        const policyBlocked = categoryContributions.every((contribution) => contribution.policyBlocked)
        const policy = policyBlocked ? policyDecision(this.policy, [manifest.id, `${manifest.id}/${category}`]) : { allowed: true }
        const policyReason = policyBlocked
          ? policy.reason ?? `All contributions in '${manifest.id}/${category}' are blocked by deployment policy.`
          : undefined
        return {
          category,
          enabled: this.gatesState.categories[`${manifest.id}/${category}`] !== false,
          policyBlocked,
          ...(policyReason === undefined ? {} : { policyReason }),
          contributions: categoryContributions,
        }
      })
      const policyBlocked = contributions.length === 0
        ? !policyDecision(this.policy, [manifest.id]).allowed
        : contributions.every((contribution) => contribution.policyBlocked)
      const packPolicy = policyBlocked ? policyDecision(this.policy, [manifest.id]) : { allowed: true }
      const policyReason = policyBlocked
        ? packPolicy.reason ?? `All contributions in '${manifest.id}' are blocked by deployment policy.`
        : undefined
      return [{
        manifest,
        registered: installed !== undefined,
        active: contributions.some((contribution) => contribution.active),
        enabled: this.gatesState.packs[manifest.id] !== false,
        policyBlocked,
        ...(policyReason === undefined ? {} : { policyReason }),
        diagnostics: [...diagnostics],
        contributions,
        categories,
      }]
    })
  }

  // -- internals ----------------------------------------------------------------

  private rememberFailure(pack: InstalledPack<TTextEditorExtension>): void {
    this.failed.set(pack.manifest.id, {
      manifest: pack.manifest,
      diagnostics: [...pack.diagnostics],
      contributedIds: new Set([...pack.slots.values()].filter((slot) => slot.payload !== undefined).map((slot) => slot.decl.id)),
    })
    this.presentationOrder.add(pack.manifest.id)
  }

  private withRegistryBatch(action: () => boolean): void {
    const finish = this.options.beginRegistryBatch?.() ?? (() => {})
    let commit = false
    try {
      commit = action()
    } finally {
      finish(commit)
    }
  }

  private deactivatePack(pack: InstalledPack<TTextEditorExtension>): void {
    this.installed.delete(pack.manifest.id)
    pack.controller.abort()
    this.unregisterPackSlots(pack)
    this.disposePackResources(pack)
  }

  private disposePackResources(pack: InstalledPack<TTextEditorExtension>): void {
    for (const disposer of [...pack.disposers].reverse()) {
      try {
        disposer()
      } catch (e) {
        pack.diagnostics.push(diag('error', 'extension', 'extension.cleanup-failed', `pack '${pack.manifest.id}' cleanup threw: ${String(e)}`))
      }
    }
    pack.disposers.length = 0
  }

  private unregisterPackSlots(pack: InstalledPack<TTextEditorExtension>): void {
    for (const slot of [...pack.slots.values()].reverse()) {
      const unregister = slot.unregister
      slot.unregister = undefined
      if (!unregister) continue
      try {
        unregister()
      } catch (e) {
        pack.diagnostics.push(diag('error', 'extension', 'extension.cleanup-failed', `contribution '${slot.decl.id}' cleanup threw: ${String(e)}`))
      }
    }
  }

  /**
   * Reconcile one slot's registration with its effective gate. Registry
   * refusals (e.g. two packs claiming the same widget kind type) become
   * pack diagnostics, never throws: a conflicted contribution must not
   * crash the gate flip that tried to admit it. The slot stays inactive
   * and is retried on the next flip - so freeing the identity (disabling
   * the other claimant) lets a re-enable succeed.
   */
  private applyGate(slot: Slot<TTextEditorExtension>): void {
    const want = slot.payload !== undefined && this.contributionEnabled(slot.packId, slot.decl)
    const have = slot.unregister !== undefined
    if (want === have) return
    if (!want) {
      const unregister = slot.unregister!
      slot.unregister = undefined
      try {
        unregister()
      } catch (e) {
        const pack = this.installed.get(slot.packId)
        pack?.diagnostics.push(diag('error', 'extension', 'extension.cleanup-failed', `contribution '${slot.decl.id}' cleanup threw: ${String(e)}`))
      }
      return
    }
    const p = slot.payload!
    const conflictMessage = `contribution '${slot.decl.id}' failed to register:`
    try {
      slot.unregister =
        p.category === 'menu'
          ? this.menus.register(p.value)
          : p.category === 'widgetKind'
            ? this.widgets.registerKind(p.value)
            : p.category === 'widgetView'
              ? this.widgets.registerView(p.value)
              : p.category === 'previewRenderer'
                ? this.widgets.registerPreviewRenderer(p.value)
                : p.category === 'textEditorExtension'
                  ? this.options.registerTextEditorExtension?.(p.value) ?? (() => {})
                  : p.category === 'canvasLayer'
                    ? this.options.registerCanvasLayer?.(p.value) ?? (() => {})
                : p.category === 'setting'
                  ? this.options.registerSetting?.(p.value) ?? (() => {})
                  : p.category === 'command'
                    ? this.options.registerCommand?.(p.value) ?? (() => {})
                    : p.category === 'keybinding'
                      ? this.options.registerKeybinding?.(p.value) ?? (() => {})
                      : p.category === 'hostUi'
                        ? this.options.registerHostUi?.(p.value.id, p.value.slot, p.value.provider, p.value.order, p.value.title) ?? (() => {})
                        : p.category === 'searchProvider'
                          ? this.options.registerSearchProvider?.(p.value) ?? (() => {})
                          : p.category === 'eventConsumer'
                            ? this.options.registerEventConsumer?.(slot.decl.id, p.value) ?? (() => {})
                            : p.category === 'virtualNode'
                              ? this.options.registerVirtualNode?.(p.value) ?? (() => {})
                              : p.category === 'editor'
                                ? this.options.registerEditor?.(p.value) ?? (() => {})
                                : p.category === 'editorBinding'
                                  ? this.options.registerEditorBinding?.(p.value) ?? (() => {})
                                  : this.options.registerPanel?.(p.value) ?? (() => {})
      const pack = this.installed.get(slot.packId)
      if (pack) {
        for (let index = pack.diagnostics.length - 1; index >= 0; index--) {
          const diagnostic = pack.diagnostics[index]!
          if (diagnostic.code === 'extension.contribution-conflict' && diagnostic.message.startsWith(conflictMessage)) {
            pack.diagnostics.splice(index, 1)
          }
        }
      }
    } catch (e) {
      const pack = this.installed.get(slot.packId)
      if (!pack) return
      const message = `contribution '${slot.decl.id}' failed to register: ${String(e)}`
      if (!pack.diagnostics.some((d) => d.code === 'extension.contribution-conflict' && d.message === message)) {
        pack.diagnostics.push(diag('error', 'extension', 'extension.contribution-conflict', message))
      }
    }
  }
}
