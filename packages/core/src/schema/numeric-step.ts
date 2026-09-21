/** Shared numeric stepping keeps canvas controls and queue-time advancement identical. */
import { formatNumber } from '../i18n/index.js'
import { comboOptionLabel } from './combo-options.js'
import type { WidgetSpec } from './model.js'

const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER)
const MIN_SAFE_INTEGER = BigInt(Number.MIN_SAFE_INTEGER)
export const MIN_INTEGER_WIDGET_VALUE = -(2n ** 63n)
export const MAX_INTEGER_WIDGET_VALUE = 2n ** 64n - 1n
const CANONICAL_DECIMAL_INTEGER = /^-?(?:0|[1-9][0-9]*)$/

export type IntegerWidgetValue = number | string

export interface IntegerStepConstraints {
  readonly integer: true
  readonly step: bigint
  readonly min?: bigint
  readonly max?: bigint
}

export interface FloatStepConstraints {
  readonly integer: false
  readonly step: number
  readonly min: number
  readonly max: number
}

export type NumericStepConstraints = IntegerStepConstraints | FloatStepConstraints

export function isCanonicalUnsafeInteger(value: unknown): value is string {
  if (typeof value !== 'string' || !CANONICAL_DECIMAL_INTEGER.test(value)) return false
  try {
    const parsed = BigInt(value)
    return parsed >= MIN_INTEGER_WIDGET_VALUE && parsed <= MAX_INTEGER_WIDGET_VALUE
      && (parsed < MIN_SAFE_INTEGER || parsed > MAX_SAFE_INTEGER)
  } catch {
    return false
  }
}

export function isIntegerWidgetValue(value: unknown): value is IntegerWidgetValue {
  return (typeof value === 'number' && Number.isFinite(value)
    && (!Number.isInteger(value) || Number.isSafeInteger(value)))
    || isCanonicalUnsafeInteger(value)
}

export function integerWidgetValue(value: bigint): IntegerWidgetValue {
  return value >= MIN_SAFE_INTEGER && value <= MAX_SAFE_INTEGER ? Number(value) : value.toString()
}

function finiteOption(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function integerOption(value: unknown): bigint | undefined {
  if (isCanonicalUnsafeInteger(value)) return BigInt(value)
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) return undefined
  if (value > Number.MAX_SAFE_INTEGER) return MAX_SAFE_INTEGER
  if (value < Number.MIN_SAFE_INTEGER) return MIN_SAFE_INTEGER
  return BigInt(value)
}

export function numericStepConstraints(widget: Pick<WidgetSpec, 'widgetType' | 'options'>): NumericStepConstraints {
  const integer = widget.widgetType === 'INT'
  if (integer) {
    let min = integerOption(widget.options['min'])
    let max = integerOption(widget.options['max'])
    const rawMin = widget.options['min']
    const rawMax = widget.options['max']
    const invertedLegacyRange = typeof rawMin === 'number' && typeof rawMax === 'number'
      && Number.isFinite(rawMin) && Number.isFinite(rawMax) && rawMin > rawMax
    if (invertedLegacyRange || (min !== undefined && max !== undefined && min > max)) {
      min = undefined
      max = undefined
    }
    const declaredStep = integerOption(widget.options['step'])
    return {
      integer: true,
      step: declaredStep !== undefined && declaredStep > 0n ? declaredStep : 1n,
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
    }
  }

  const rawMin = finiteOption(widget.options['min'])
  const rawMax = finiteOption(widget.options['max'])
  const validRange = rawMin === undefined || rawMax === undefined || rawMin <= rawMax
  const declaredStep = finiteOption(widget.options['step'])
  return {
    integer: false,
    step: declaredStep !== undefined && declaredStep > 0 ? declaredStep : 0.1,
    min: validRange ? (rawMin ?? -Infinity) : -Infinity,
    max: validRange ? (rawMax ?? Infinity) : Infinity,
  }
}

export function numericStepPrecision(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0
  const [coefficient, exponentText] = Math.abs(step).toString().toLowerCase().split('e')
  const fraction = coefficient?.split('.')[1]?.length ?? 0
  const exponent = Number(exponentText ?? 0)
  return Math.min(20, Math.max(0, fraction - exponent))
}

const quantize = (value: number): number => Math.round(value * 1e12) / 1e12

function integerValue(value: IntegerWidgetValue): bigint {
  if (isCanonicalUnsafeInteger(value)) return BigInt(value)
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0n
  return BigInt(Math.round(Math.max(Number.MIN_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, value))))
}

export function stepNumericValue(
  current: IntegerWidgetValue,
  direction: -1 | 1,
  constraints: NumericStepConstraints,
): IntegerWidgetValue {
  if (constraints.integer) {
    const min = constraints.min ?? MIN_INTEGER_WIDGET_VALUE
    const max = constraints.max ?? MAX_INTEGER_WIDGET_VALUE
    const stepped = integerValue(current) + BigInt(direction) * constraints.step
    return integerWidgetValue(stepped < min ? min : stepped > max ? max : stepped)
  }
  const numericCurrent = typeof current === 'number' ? current : 0
  const stepped = quantize(numericCurrent + direction * constraints.step)
  return Math.min(constraints.max, Math.max(constraints.min, stepped))
}

function randomBits96(random: () => number): bigint {
  const chunk = (): bigint => BigInt(Math.floor(Math.max(0, Math.min(0.9999999999999999, random())) * 0x100000000))
  return (chunk() << 64n) | (chunk() << 32n) | chunk()
}

/** Seed-style randomization: INT ignores step; FLOAT samples the declared step grid. */
export function randomNumericValue(
  constraints: NumericStepConstraints,
  random: () => number = Math.random,
): IntegerWidgetValue {
  if (constraints.integer) {
    const min = constraints.min ?? 0n
    const declaredMax = constraints.max ?? MAX_SAFE_INTEGER
    const max = declaredMax < min ? min : declaredMax
    const span = max - min + 1n
    const offset = (randomBits96(random) * span) >> 96n
    return integerWidgetValue(min + offset)
  }
  const min = Number.isFinite(constraints.min) ? constraints.min : 0
  const max = Number.isFinite(constraints.max) ? constraints.max : min + 1
  let points = Math.max(0, Math.floor(quantize((max - min) / constraints.step)))
  while (points > 0 && quantize(min + points * constraints.step) > max) points--
  const value = quantize(min + Math.floor(random() * (points + 1)) * constraints.step)
  return Math.min(max, Math.max(min, value))
}

export function formatWidgetValue(value: unknown, spec: Pick<WidgetSpec, 'widgetType' | 'options'>): string {
  if (spec.widgetType === 'FLOAT' && typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value)
    const constraints = numericStepConstraints(spec)
    if (constraints.integer) return String(value)
    const digits = Math.max(1, numericStepPrecision(constraints.step))
    return formatNumber(value === 0 ? 0 : value, {
      useGrouping: false,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })
  }
  if (spec.widgetType === 'INT' && typeof value === 'number' && Number.isFinite(value)) return String(Math.round(value))
  if (spec.widgetType === 'INT' && isCanonicalUnsafeInteger(value)) return value
  if (spec.widgetType === 'COMBO' && (typeof value === 'string' || typeof value === 'number')) {
    return comboOptionLabel(value, spec)
  }
  if (spec.widgetType === 'MULTI_COMBO' && Array.isArray(value)) {
    return value.map((item) => typeof item === 'string' || typeof item === 'number'
      ? comboOptionLabel(item, spec)
      : String(item)).join(', ')
  }
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return value === null ? 'null' : ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}
