/**
 * Menu contribution contract.
 *
 * Context menus are an extension surface, so they follow the same rule as
 * widgets and commands: ONE typed registry that core and extensions use
 * identically - no monkey patching, no DOM interception, no private hooks.
 *
 * A contribution declares WHICH targets it serves and resolves to zero or
 * more concrete items for a given context (returning none = hidden). Items
 * are plain data; their actions are either serializable command invocations
 * (dispatched through the document store) or named HOST ACTIONS the shell
 * implements (navigation/UI concerns that are not document mutations).
 *
 * Well-known host actions the app shell provides:
 * - 'openSubgraph'    {nodeId}   drill into a subgraph instance
 * - 'createSubgraph'  {}         create an empty definition at the menu point and drill in
 * - 'createRegion'    {kind}     create a fresh map/fold/while region and select its occurrence
 * - 'openPalette'     {}         open the add-node palette at the menu point
 * - 'deleteSelection' {}         delete the current selection (nodes+links+reroutes)
 * - 'queueSelection'  {nodeIds}  partial-execute: queue the union of upstream
 *                                closures of these root nodes' minima
 */

import type { CommandInvocation } from '../commands/contract.js'
import type { Json, WorkflowDocument } from '../format/document.js'

// ---------------------------------------------------------------------------
// Targets and context
// ---------------------------------------------------------------------------

/** What was right-clicked. Plain data mirroring the canvas hit kinds. */
export type MenuTarget =
  | { readonly kind: 'canvas' }
  | {
      readonly kind: 'node'
      readonly nodeId: string
      /** The canvas currently projects a preview surface for this node. */
      readonly previewSurface?: true
    }
  | {
      readonly kind: 'link'
      readonly linkId: string
      /** Set when the noodle renders a named-net fan-out (synthetic link id). */
      readonly netId?: string
      /** Consumer end: a real input, a reroute junction, or a selector branch (nets are port-only). */
      readonly to:
        | { readonly node: string; readonly port: string; readonly members?: readonly string[] }
        | { readonly reroute: string }
        | { readonly selector: string; readonly candidate: string }
    }
  | { readonly kind: 'reroute'; readonly rerouteId: string }
  | { readonly kind: 'valueSource'; readonly valueSourceId: string }
  | { readonly kind: 'selector'; readonly selectorId: string }
  | {
      readonly kind: 'pin'
      readonly nodeId: string
      readonly portId: string
      /** Dynamic member-id path, when the pin is an elaborated member. */
      readonly members?: readonly string[]
      readonly direction: 'in' | 'out'
    }
  | {
      /** A collapsed net's endpoint tag (source or sink stub). */
      readonly kind: 'net'
      readonly netId: string
      readonly role: 'source' | 'sink'
      readonly nodeId: string
      readonly portId: string
      /** Dynamic member-id path, when the endpoint is an elaborated member. */
      readonly members?: readonly string[]
    }
  | {
      readonly kind: 'widget'
      readonly nodeId: string
      readonly inputId: string
      /**
       * Canonical value owner when the row PRESENTS forwarded state (a
       * subgraph instance surfacing another node's family member). Items
       * that record or address the value's document home (e.g. expose)
       * must use this triple; nodeId/inputId stay the displayed identity.
       */
      readonly owner?: { readonly graphId: string; readonly nodeId: string; readonly inputId: string }
      /**
       * Unpersisted presentation row (ghost/materialize affordance): there
       * is no document value to address, so identity-recording items must
       * not offer themselves.
       */
      readonly synthetic?: true
    }
  | { readonly kind: 'group'; readonly groupId: string }
  | {
      readonly kind: 'section'
      readonly nodeId: string
      readonly sectionId: string
      /** Effective collapse state at click time. */
      readonly collapsed: boolean
    }

export interface MenuContext {
  readonly doc: WorkflowDocument
  /** App-owned feature capabilities. Omitted means enabled for headless/integration consumers. */
  readonly features?: { readonly namedNets?: boolean }
  /** Schema display name for the targeted node. Missing schemas fall back to NodeData.type. */
  readonly nodeDisplayName?: string
  /** Full help availability for the targeted node (wire 42). */
  readonly nodeHasDocs?: boolean
  /**
   * Live-preview capability of a node type (subgraph '#GraphDefId' types
   * included; their derived schemas aggregate inner nodes). Omitted means
   * unknown: items keep preview affordances available on every node, for
   * headless consumers and backends whose schemas predate the flag.
   */
  readonly previewCapable?: (nodeType: string) => boolean
  /**
   * Mirror-estimate capability of a node type: whether its schema declares
   * a mirror this frontend can evaluate locally. Omitted means unknown:
   * the mirror-estimate override menu stays hidden (an override on a node
   * that can never estimate would be dead state).
   */
  readonly mirrorCapable?: (nodeType: string) => boolean
  /** Graph definition being edited (root or a drilled-in subgraph). */
  readonly graphId: string
  readonly target: MenuTarget
  /** Selection at menu-open time; the right-clicked item is already in it. */
  readonly selection: {
    readonly nodes: readonly string[]
    readonly links: readonly string[]
    readonly reroutes: readonly string[]
    readonly valueSources: readonly string[]
    readonly selectors: readonly string[]
  }
  /** Menu anchor in world coordinates (e.g. where 'Add Node' places a node). */
  readonly worldX: number
  readonly worldY: number
  /** Current host keybinding display strings keyed by command id. */
  readonly shortcuts?: Readonly<Record<string, string>>
}

// ---------------------------------------------------------------------------
// Items and actions
// ---------------------------------------------------------------------------

export type MenuAction =
  | { readonly kind: 'command'; readonly invocation: CommandInvocation }
  | { readonly kind: 'host'; readonly action: string; readonly params?: Json }

interface MenuItemBase {
  /** Stable id, namespaced by the contributor ('core.node.mode.muted'). */
  readonly id: string
  readonly label: string
  /** Optional frontend-local decorative icon name. */
  readonly icon?: string
  /** Optional visible keybinding display string. */
  readonly shortcut?: string
  /** Optional right-aligned secondary text, such as a current keybinding. */
  readonly hint?: string
  readonly checked?: boolean
  readonly disabled?: boolean
}

/** A terminal row. Invoking it dispatches its command or named host action. */
export interface MenuActionItem extends MenuItemBase {
  readonly action: MenuAction
  readonly children?: never
}

/** A cascading row. Children may recursively contain deeper submenus. */
export interface MenuSubmenuItem extends MenuItemBase {
  readonly action?: never
  readonly children: readonly MenuItem[]
}

/** Plain recursive menu data; a row is either invokable or opens children. */
export type MenuItem = MenuActionItem | MenuSubmenuItem

export interface MenuContribution {
  /** Stable namespaced id ('core.node.mode', 'vhs.timeline.export'). */
  readonly id: string
  readonly targets: readonly MenuTarget['kind'][]
  /**
   * Grouping key: items of the same group render together, groups are
   * separated visually and ordered lexicographically ('10-nav' < '90-edit').
   */
  readonly group: string
  /** Order within the group (lower first, then contribution id). */
  readonly order?: number
  /** Concrete items for this context. Empty = contribution hidden. */
  resolve(ctx: MenuContext): readonly MenuItem[]
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface ResolvedMenuGroup {
  readonly group: string
  readonly items: readonly MenuItem[]
}

export interface MenuRegistry {
  /** Register a contribution; returns an unregister function. Duplicate ids throw. */
  register(contribution: MenuContribution): () => void
  /** All groups with at least one item for this context, in render order. */
  resolve(ctx: MenuContext): readonly ResolvedMenuGroup[]
}

export function createMenuRegistry(): MenuRegistry {
  const contributions = new Map<string, MenuContribution>()
  return {
    register(contribution) {
      if (contributions.has(contribution.id)) {
        throw new Error(`menu contribution '${contribution.id}' already registered`)
      }
      contributions.set(contribution.id, contribution)
      return () => {
        contributions.delete(contribution.id)
      }
    },
    resolve(ctx) {
      const applicable = [...contributions.values()]
        .filter((c) => c.targets.includes(ctx.target.kind))
        .sort(
          (a, b) =>
            a.group.localeCompare(b.group) ||
            (a.order ?? 0) - (b.order ?? 0) ||
            a.id.localeCompare(b.id),
        )
      const groups: { group: string; items: MenuItem[] }[] = []
      for (const c of applicable) {
        const items = c.resolve(ctx)
        if (items.length === 0) continue
        const last = groups[groups.length - 1]
        if (last && last.group === c.group) last.items.push(...items)
        else groups.push({ group: c.group, items: [...items] })
      }
      return groups
    },
  }
}
