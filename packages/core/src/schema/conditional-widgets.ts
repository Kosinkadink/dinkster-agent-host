import type { NodeData } from '../format/document.js'
import { effectiveWidgetDefault } from './widget-defaults.js'
import { inputsOf, type ConditionalWidgetCondition, type NodeSchema } from './model.js'

const scalar = (value: unknown): value is null | string | boolean | number =>
  value === null || typeof value === 'string' || typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value) &&
    (!Number.isInteger(value) || Number.isSafeInteger(value)))

/** Returns top-level static widget ids hidden by schema-declared groups. */
export function hiddenConditionalWidgets(
  schema: NodeSchema,
  node: Pick<NodeData, 'values'>,
  connected: (direction: 'in' | 'out', input: string) => boolean = () => false,
): ReadonlySet<string> {
  const groups = schema.widgetGroups ?? []
  const inputs = new Map(inputsOf(schema).filter((input) => input.dynamic === undefined && input.widget !== undefined).map((input) => [input.id, input]))
  const shown = new Set<string>()
  const controlled = new Set(groups.flatMap((group) => group.members))
  for (const group of groups) {
    const conditions: readonly ConditionalWidgetCondition[] = [group, ...(group.requires ?? [])]
    const results = conditions.map((condition): boolean | undefined => {
      const driver = inputs.get(condition.input)
      const stored = Object.prototype.hasOwnProperty.call(node.values, condition.input)
      const value = stored ? node.values[condition.input] : driver?.widget === undefined ? undefined : effectiveWidgetDefault(driver.widget)
      if (driver === undefined || connected('in', condition.input) || !scalar(value)) {
        return undefined
      }
      return condition.values.some((candidate) => candidate === value)
    })
    const matches = results.includes(undefined) || results.every(Boolean)
    if (matches) group.members.forEach((member) => shown.add(member))
  }
  return new Set([...controlled].filter((member) => !shown.has(member) && !connected('in', member) && !connected('out', member)))
}
