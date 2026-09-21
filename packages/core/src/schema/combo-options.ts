import type { WidgetSpec } from './model.js'

export interface NormalizedComboOption {
  readonly value: string | number
  readonly label: string
  readonly info?: string
  readonly folder?: string
}

const comboValue = (value: unknown): value is string | number =>
  typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))

/** Normalize native structured choices and legacy scalar/[value, label] choices. */
export function normalizeComboOption(option: unknown): NormalizedComboOption | undefined {
  if (comboValue(option)) return { value: option, label: String(option) }
  if (Array.isArray(option)) {
    const value = option[0]
    if (!comboValue(value)) return undefined
    return {
      value,
      label: typeof option[1] === 'string' && option[1] !== '' ? option[1] : String(value),
    }
  }
  if (typeof option !== 'object' || option === null) return undefined
  const record = option as Record<string, unknown>
  const value = record['value']
  if (!comboValue(value)) return undefined
  const label = record['label']
  const info = record['info']
  const folder = record['folder']
  return {
    value,
    label: typeof label === 'string' && label !== '' ? label : String(value),
    ...(typeof info === 'string' && info !== '' ? { info } : {}),
    ...(typeof folder === 'string' && folder !== '' ? { folder } : {}),
  }
}

/** Static choices in schema order, with presentation separate from stored values. */
export function normalizedComboOptions(
  spec: Pick<WidgetSpec, 'options'>,
): readonly NormalizedComboOption[] {
  const options = spec.options['options']
  if (!Array.isArray(options)) return []
  return options.flatMap((option) => {
    const normalized = normalizeComboOption(option)
    return normalized === undefined ? [] : [normalized]
  })
}

/** Display text for a stored choice without changing the stored value. */
export function comboOptionLabel(
  value: string | number,
  spec: Pick<WidgetSpec, 'options'>,
): string {
  return normalizedComboOptions(spec).find((option) => option.value === value)?.label ?? String(value)
}
