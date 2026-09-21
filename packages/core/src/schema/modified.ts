/**
 * Derived modified-from-default state for widget values.
 *
 * "Modified" is NEVER stored - it is a pure function of (elaborated
 * interface, node.values): the stored value differs (canonical JSON) from
 * the LIVE schema default. Loading never mutates values, so a workflow saved
 * under an older schema whose default later changed legitimately reads as
 * modified: it really does differ from what a freshly added node gets today.
 * Restoring old-version semantics is the deprecation/replacement system's
 * job, not this module's.
 *
 * Eligibility (what "resettable" means):
 * - widget-backed inputs rendered as widgets (forceInput = socket, excluded);
 * - the widget declares a schema default (no default = nothing to reset);
 * - controller-slotted widgets (control_after_generate / _refresh) are
 *   EXCLUDED: their values advance by design on every queue, so comparing
 *   them to the default is permanent noise, not signal;
 * - selector rows are excluded (their value is dynamic state, not values);
 * - ghost/synthetic dynamic members are excluded (nothing persisted yet).
 *
 * Connectivity is deliberately ignored: a connected widget's stored value
 * still serializes and comes back when disconnected, so it counts.
 */

import { canonicalJson } from '../compile/hash.js'
import type { Json } from '../format/document.js'
import {
  materializeFramesOf,
  valueKeyOf,
  type ElaboratedInput,
  type ElaboratedInterface,
} from './elaborate.js'

export interface ResettableWidget {
  readonly item: ElaboratedInput
  /** node.values key (valueKeyOf) - the reset write target. */
  readonly valueKey: string
  /** The live schema default - the reset write value. */
  readonly defaultValue: Json
  /** Stored value differs (canonical JSON) from the live default. */
  readonly modified: boolean
}

/** Deep JSON equality via canonical (sorted-key) serialization. */
const jsonEquals = (a: Json | undefined, b: Json | undefined): boolean =>
  canonicalJson(a) === canonicalJson(b)

/**
 * Widget-backed inputs eligible for modified/reset semantics, in interface
 * order. A missing values key means the widget sits at its default
 * (compile applies the default for absent keys), so it is NOT modified.
 */
export function resettableWidgetsOf(
  elaborated: ElaboratedInterface,
  values: Readonly<Record<string, Json>>,
): readonly ResettableWidget[] {
  const out: ResettableWidget[] = []
  for (const item of elaborated.items) {
    if (item.kind !== 'input') continue
    const widget = item.spec.widget
    if (widget === undefined || item.spec.forceInput === true) continue
    if (item.origin.kind === 'selector') continue
    if (widget.default === undefined || widget.controller !== undefined) continue
    const ghost =
      (item.origin.kind === 'member' && item.origin.ghost === true) ||
      item.ancestry?.some((a) => a.ghost) === true
    if (ghost || materializeFramesOf(elaborated.items, item) !== undefined) continue
    const valueKey = valueKeyOf(item)
    const stored = values[valueKey]
    const defaultValue = widget.default as Json
    out.push({
      item,
      valueKey,
      defaultValue,
      modified: stored !== undefined && !jsonEquals(stored, defaultValue),
    })
  }
  return out
}
