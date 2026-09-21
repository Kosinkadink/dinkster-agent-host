/**
 * Effective submission-time widget defaults.
 *
 * A widget input intrinsically HAS a value even when the schema declares no
 * explicit `default`: an INT widget shows 0 (or its minimum), a STRING shows
 * '', a BOOLEAN shows false, a static COMBO shows its first option, and a
 * CURVE shows the monotone-cubic identity. COMPOSITOR starts with its exact
 * empty recipe. What the user sees on the canvas is what executing the
 * workflow must use - so compile falls back to these kind-level defaults
 * instead of reporting `compile.input.missing` / `compile.tap.novalue` for a
 * value that is visibly right there.
 *
 * This mirrors the DISPLAY defaults in `@dinkster/widgets` kinds.ts (which
 * cannot be imported here - widgets depends on core). The two deliberately
 * diverge where display and submission semantics differ:
 *
 * - ASSET / SAVE_TARGET display `null` ("explicitly unset"), but a required
 *   asset without a chosen file genuinely cannot execute - no submission
 *   fallback, so the missing-input warning stays.
 * - A purely remote COMBO has no local option list; the display shows ''
 *   but submitting '' would be an invented value - no fallback. A remote
 *   COMBO WITH static options displays its first static option, so that
 *   option is also the submission fallback (display and execution agree).
 * - A malformed explicit default (wrong JSON shape for the kind) is ignored
 *   the same way the widget's value schema would reject it, falling back to
 *   the kind's intrinsic default instead of compiling an invalid value.
 *
 * `packages/core/test/widget-defaults.test.ts` pins the agreement with the
 * widgets package for the kinds that must match.
 */
import type { Json } from '../format/document.js'
import { EMPTY_COMPOSITOR_RECIPE, isCompositorRecipe } from '../compositor.js'
import { normalizeComboOption } from './combo-options.js'
import type { WidgetSpec } from './model.js'

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** A value a COMBO can hold: a JSON-representable option scalar. */
const comboValue = (v: unknown): v is string | number => typeof v === 'string' || finite(v)

/** Mirrors widgets kinds.ts isCurveValue without importing the downstream package. */
function curveValue(v: unknown): boolean {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const curve = v as Record<string, unknown>
  const interpolation = curve['interpolation']
  const keys = Object.keys(curve).sort()
  if (keys.join(',') !== (interpolation === undefined ? 'points' : 'interpolation,points')) return false
  if (interpolation !== undefined && interpolation !== 'linear' && interpolation !== 'monotone_cubic') return false
  const points = curve['points']
  if (!Array.isArray(points) || points.length < 1 || points.length > 4096) return false
  let previous = -Infinity
  return points.every((point) => {
    if (typeof point !== 'object' || point === null || Array.isArray(point)) return false
    const record = point as Record<string, unknown>
    const position = record['position']
    const value = record['value']
    if (Object.keys(record).sort().join(',') !== 'position,value' || !finite(position) || !finite(value) || position <= previous) return false
    previous = position
    return true
  })
}

/** Mirrors widgets kinds.ts isAssetRef: a complete, executable asset reference. */
export function isAssetRefValue(v: unknown): boolean {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const asset = v as Record<string, unknown>
  return typeof asset['digest'] === 'string' && /^blake3:[0-9a-f]{64}$/.test(asset['digest']) &&
    typeof asset['name'] === 'string' &&
    typeof asset['size'] === 'number' && Number.isSafeInteger(asset['size']) && (asset['size'] as number) >= 0 &&
    typeof asset['mediaType'] === 'string' && typeof asset['virtualPath'] === 'string'
}

/** Mirrors widgets kinds.ts isSaveTarget: {mount, prefix} obeying the backend grammar. */
export function isSaveTargetValue(v: unknown): v is { readonly mount: string; readonly prefix: string } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const target = v as Record<string, unknown>
  const mount = target['mount']
  const prefix = target['prefix']
  if (typeof mount !== 'string' || !/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(mount)) return false
  if (typeof prefix !== 'string' || prefix === '' || prefix.includes('\\')) return false
  return prefix.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/**
 * Mirrors each kind's valueSchema: is this explicit default usable as a
 * SUBMISSION value? Stricter than mere load-shape for ASSET/SAVE_TARGET:
 * `null` is their DISPLAY placeholder ("explicitly unset"), never a value a
 * prompt can execute, so a null default is not usable here.
 */
function validDefault(widget: WidgetSpec): boolean {
  const d = widget.default
  switch (widget.widgetType) {
    case 'INT':
    case 'FLOAT':
      return finite(d)
    case 'STRING':
    case 'COLOR':
      return typeof d === 'string'
    case 'BOOLEAN':
      return typeof d === 'boolean'
    case 'COMBO':
      return comboValue(d)
    case 'MULTI_COMBO':
      return Array.isArray(d) && d.every((value) => typeof value === 'string')
    case 'CURVE':
      return curveValue(d)
    case 'COMPOSITOR':
      return isCompositorRecipe(d)
    case 'ASSET':
      // Multi-select (list-declared) asset inputs store ARRAYS of refs;
      // a non-empty all-ref array is as submittable as a single ref.
      return isAssetRefValue(d) || (Array.isArray(d) && d.length > 0 && d.every(isAssetRefValue))
    case 'SAVE_TARGET':
      return isSaveTargetValue(d)
    default:
      return true // unknown kinds: no local shape truth, pass through
  }
}

/**
 * The value a widget input effectively holds when the document stores none
 * and the schema declares no usable explicit default; `undefined` when the
 * widget kind has no intrinsic value (ASSET, SAVE_TARGET, remote-only/empty
 * COMBO, unknown types) - those genuinely need the user or a connection.
 */
export function effectiveWidgetDefault(widget: WidgetSpec): Json | undefined {
  if (widget.default !== undefined && validDefault(widget)) return widget.default as Json
  switch (widget.widgetType) {
    case 'INT':
    case 'FLOAT': {
      const min = widget.options['min']
      return finite(min) ? min : 0
    }
    case 'STRING':
      return ''
    case 'BOOLEAN':
      return false
    case 'COMBO': {
      // Static options are usable even alongside a remote route: the widget
      // displays the first static option, so execution uses it too. Purely
      // remote combos have no local truth about options.
      const options = widget.options['options']
      if (!Array.isArray(options)) return undefined
      for (const option of options) {
        const value = normalizeComboOption(option)?.value
        if (value !== undefined && comboValue(value)) return value
      }
      return undefined
    }
    case 'MULTI_COMBO':
      return []
    case 'COLOR':
      return '#ffffff'
    case 'CURVE':
      return {
        interpolation: 'monotone_cubic',
        points: [{ position: 0, value: 0 }, { position: 1, value: 1 }],
      }
    case 'COMPOSITOR':
      return EMPTY_COMPOSITOR_RECIPE as unknown as Json
    default:
      return undefined
  }
}
