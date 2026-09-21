import type { BoundaryItem } from '../format/document.js'

const ACRONYMS = new Set(['api', 'cfg', 'clip', 'id', 'ip', 'url', 'vae'])

export function generatedBoundaryLabel(
  item: BoundaryItem,
  source = item.binds.kind === 'widgetTap' ? item.binds.tap as string : item.binds.port as string,
): string {
  const segment = source.split('.').at(-1) || item.id.split('.').at(-1) || item.id
  const memberSuffix = /(?:_|-|\s)m\d+$/i.test(segment)
  let semantic = segment.replace(/(?:_|-|\s)m\d+$/i, '').replace(/(?:_|-|\s)\d+$/, '')
  if (memberSuffix && semantic.length > 3 && semantic.endsWith('s')) semantic = semantic.slice(0, -1)
  const words = semantic
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d+)/g, '$1 $2')
    .replace(/[_.-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) return 'Boundary'
  return words.map((word, index) => {
    const lower = word.toLowerCase()
    if (ACRONYMS.has(lower)) return lower.toUpperCase()
    return index === 0 ? lower[0]!.toUpperCase() + lower.slice(1) : lower
  }).join(' ')
}

/** Generated user labels in stable boundary order; custom labels stay separate. */
export function defaultBoundaryLabels(items: readonly BoundaryItem[]): ReadonlyMap<string, string> {
  const labels = new Map<string, string>()
  const counts = new Map<string, number>()
  for (const item of items) {
    const base = generatedBoundaryLabel(item)
    const key = base.toLowerCase()
    const ordinal = (counts.get(key) ?? 0) + 1
    counts.set(key, ordinal)
    labels.set(item.id, ordinal === 1 ? base : `${base} ${ordinal}`)
  }
  return labels
}
