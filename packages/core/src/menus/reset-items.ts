/**
 * Reset-to-default menu contributions.
 *
 * Unlike core-items (deliberately schema-blind), reset needs to know each
 * widget's live schema default, so these contributions are a FACTORY over a
 * schema resolver getter and the app registers them alongside the core set -
 * through the same public registry extensions use. The context stays plain
 * data; schema access rides the closure, never MenuContext.
 *
 * Semantics (architecture section 12):
 * - Reset means "make this widget equal to a freshly added node TODAY": it
 *   writes the CURRENT schema default EXPLICITLY into node.values - never
 *   deletes the key, which would silently track future defaults and break
 *   exact reproduction.
 * - Multi-widget resets dispatch ONE node.setValues = one undo step.
 * - Only MODIFIED widgets are written (unmodified ones stay as they are -
 *   absent keys are not pinned by someone else's reset).
 * - Items hide when the target has no resettable widgets at all, and render
 *   disabled when none of them are modified.
 */

import { documentNodeResolver } from '../compile/compile.js'
import type { Json } from '../format/document.js'
import { elaborateInterface } from '../schema/elaborate.js'
import type { SchemaResolver } from '../schema/derive-boundary.js'
import { resettableWidgetsOf, type ResettableWidget } from '../schema/modified.js'
import type { MenuContext, MenuContribution, MenuItem } from './contract.js'

const GROUP = '80-values'

/** Resolve the target node's resettable widgets, or undefined when N/A. */
function resettableOf(
  ctx: MenuContext,
  nodeId: string,
  getResolver: () => SchemaResolver | undefined,
): readonly ResettableWidget[] | undefined {
  const base = getResolver()
  if (!base) return undefined
  const node = ctx.doc.graphs[ctx.graphId]?.nodes[nodeId]
  if (!node) return undefined
  const schema = documentNodeResolver(ctx.doc, base)(ctx.graphId, node)
  if (!schema) return undefined
  return resettableWidgetsOf(elaborateInterface(schema, node), node.values)
}

/** One node.setValues invocation writing the live default of each MODIFIED widget. */
function resetItem(
  ctx: MenuContext,
  id: string,
  label: string,
  nodeId: string,
  widgets: readonly ResettableWidget[],
): MenuItem {
  const modified = widgets.filter((w) => w.modified)
  const values: Record<string, Json> = {}
  for (const w of modified) values[w.valueKey] = w.defaultValue
  return {
    id,
    label,
    action: {
      kind: 'command',
      invocation: { command: 'node.setValues', params: { graphId: ctx.graphId, nodeId, values } },
    },
    ...(modified.length === 0 ? { disabled: true } : {}),
  }
}

export function resetMenuContributions(
  getResolver: () => SchemaResolver | undefined,
): readonly MenuContribution[] {
  const widgetReset: MenuContribution = {
    id: 'core.widget.reset',
    targets: ['widget'],
    group: GROUP,
    resolve(ctx) {
      if (ctx.target.kind !== 'widget') return []
      const t = ctx.target
      const widgets = resettableOf(ctx, t.nodeId, getResolver)
      // Widget rows carry the elaborated key as inputId (spec.id post-rewrite).
      const w = widgets?.find((r) => r.item.spec.id === t.inputId)
      if (!w) return []
      return [resetItem(ctx, 'core.widget.reset', 'Reset to Default', t.nodeId, [w])]
    },
  }

  const sectionReset: MenuContribution = {
    id: 'core.section.reset',
    targets: ['section'],
    group: GROUP,
    resolve(ctx) {
      if (ctx.target.kind !== 'section') return []
      const t = ctx.target
      const widgets = resettableOf(ctx, t.nodeId, getResolver)?.filter(
        (r) => r.item.spec.section === t.sectionId,
      )
      if (widgets === undefined || widgets.length === 0) return []
      return [
        resetItem(ctx, 'core.section.reset', 'Reset Section to Defaults', t.nodeId, widgets),
      ]
    },
  }

  const nodeReset: MenuContribution = {
    id: 'core.node.reset',
    targets: ['node'],
    group: GROUP,
    resolve(ctx) {
      if (ctx.target.kind !== 'node') return []
      const t = ctx.target
      const widgets = resettableOf(ctx, t.nodeId, getResolver)
      if (widgets === undefined || widgets.length === 0) return []
      return [
        resetItem(ctx, 'core.node.reset', 'Reset All Widgets to Defaults', t.nodeId, widgets),
      ]
    },
  }

  return [widgetReset, sectionReset, nodeReset]
}
