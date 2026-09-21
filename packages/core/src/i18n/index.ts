import { createSignal, type ReadonlySignal } from '../reactive/signal.js'

export interface Locale {
  readonly tag: string
  readonly dir: 'ltr' | 'rtl'
}

export type MessageParams = Readonly<Record<string, string | number | Date>>
export type MessageCatalog = Readonly<Record<string, string>>

const catalogs = new Map<string, MessageCatalog>()
const localeState = createSignal<Locale>({ tag: 'en', dir: 'ltr' })
const numberFormats = new Map<string, Intl.NumberFormat>()
const dateFormats = new Map<string, Intl.DateTimeFormat>()
const relativeTimeFormats = new Map<string, Intl.RelativeTimeFormat>()
const RTL_SCRIPTS = new Set([
  'Adlm', 'Arab', 'Armi', 'Avst', 'Chrs', 'Cprt', 'Elym', 'Gara', 'Hatr',
  'Hebr', 'Hung', 'Khar', 'Lydi', 'Mand', 'Mani', 'Mend', 'Merc', 'Mero',
  'Narb', 'Nbat', 'Nkoo', 'Orkh', 'Ougr', 'Palm', 'Phli', 'Phlp', 'Phnx',
  'Prti', 'Rohg', 'Samr', 'Sarb', 'Sidt', 'Sogd', 'Sogo', 'Syrc', 'Thaa',
  'Yezi',
])

export const activeLocale: ReadonlySignal<Locale> = localeState

function canonicalLocale(tag: string): string {
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? 'en'
  } catch {
    return 'en'
  }
}

function localeDirection(tag: string): Locale['dir'] {
  const locale = new Intl.Locale(tag)
  const textInfo = (locale as Intl.Locale & { readonly textInfo?: { readonly direction?: string } }).textInfo
  if (textInfo?.direction === 'rtl') return 'rtl'
  if (textInfo?.direction === 'ltr') return 'ltr'
  return RTL_SCRIPTS.has(locale.maximize().script ?? '') ? 'rtl' : 'ltr'
}

export function setLocale(tag: string): void {
  const canonical = canonicalLocale(tag)
  if (localeState.get().tag !== canonical) localeState.set({ tag: canonical, dir: localeDirection(canonical) })
}

export function registerCatalog(tag: string, catalog: MessageCatalog): void {
  catalogs.set(canonicalLocale(tag), catalog)
}

export async function loadCatalog(
  tag: string,
  loader: () => Promise<MessageCatalog>,
): Promise<void> {
  const canonical = canonicalLocale(tag)
  if (catalogs.has(canonical)) return
  registerCatalog(canonical, await loader())
}

function messageFor(key: string): string {
  const tag = activeLocale.get().tag
  return catalogs.get(tag)?.[key]
    ?? catalogs.get(tag.split('-')[0]!)?.[key]
    ?? catalogs.get('en')?.[key]
    ?? key
}

interface PluralBlock {
  readonly end: number
  readonly name: string
  readonly choices: Readonly<Record<string, string>>
}

function pluralBlockAt(message: string, start: number): PluralBlock | undefined {
  const header = /^\{\s*([A-Za-z][A-Za-z0-9_]*)\s*,\s*plural\s*,/u.exec(message.slice(start))
  if (header === null) return undefined
  let cursor = start + header[0].length
  const choices: Record<string, string> = {}
  while (cursor < message.length) {
    while (/\s/u.test(message[cursor] ?? '')) cursor++
    if (message[cursor] === '}') {
      return Object.hasOwn(choices, 'other')
        ? { end: cursor + 1, name: header[1]!, choices }
        : undefined
    }
    const category = /^(zero|one|two|few|many|other)\s*\{/u.exec(message.slice(cursor))
    if (category === null) return undefined
    cursor += category[0].length
    const bodyStart = cursor
    let depth = 1
    while (cursor < message.length && depth > 0) {
      if (message[cursor] === '{') depth++
      else if (message[cursor] === '}') depth--
      cursor++
    }
    if (depth !== 0) return undefined
    choices[category[1]!] = message.slice(bodyStart, cursor - 1)
  }
  return undefined
}

function interpolate(message: string, params: MessageParams): string {
  return message.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu, (whole, name: string) => {
    const value = params[name]
    if (value === undefined) return whole
    if (value instanceof Date) return formatDate(value)
    return typeof value === 'number' ? formatNumber(value) : value
  })
}

function formatMessage(message: string, params: MessageParams): string {
  let rendered = ''
  let cursor = 0
  while (cursor < message.length) {
    const start = message.indexOf('{', cursor)
    if (start < 0) {
      rendered += message.slice(cursor)
      break
    }
    rendered += message.slice(cursor, start)
    const block = pluralBlockAt(message, start)
    if (block === undefined) {
      rendered += message[start]
      cursor = start + 1
      continue
    }
    const count = params[block.name]
    if (typeof count !== 'number') {
      rendered += message.slice(start, block.end)
    } else {
      const category = new Intl.PluralRules(activeLocale.get().tag).select(count)
      rendered += interpolate(block.choices[category] ?? block.choices['other']!, params).replaceAll('#', formatNumber(count))
    }
    cursor = block.end
  }
  return interpolate(rendered, params)
}

export function t(key: string, params: MessageParams = {}): string {
  return formatMessage(messageFor(key), params)
}

export function tPlural(key: string, count: number, params: MessageParams = {}): string {
  return t(key, { ...params, count })
}

export function formatNumber(value: number | bigint, options?: Intl.NumberFormatOptions): string {
  const tag = activeLocale.get().tag
  const key = `${tag}:${JSON.stringify(options ?? {})}`
  let formatter = numberFormats.get(key)
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(tag, options)
    numberFormats.set(key, formatter)
  }
  return formatter.format(value)
}

export function formatDate(value: Date | number, options?: Intl.DateTimeFormatOptions): string {
  const tag = activeLocale.get().tag
  const key = `${tag}:${JSON.stringify(options ?? {})}`
  let formatter = dateFormats.get(key)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(tag, options)
    dateFormats.set(key, formatter)
  }
  return formatter.format(value)
}

export function formatRelativeTime(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
  options?: Intl.RelativeTimeFormatOptions,
): string {
  const tag = activeLocale.get().tag
  const key = `${tag}:${JSON.stringify(options ?? {})}`
  let formatter = relativeTimeFormats.get(key)
  if (formatter === undefined) {
    formatter = new Intl.RelativeTimeFormat(tag, options)
    relativeTimeFormats.set(key, formatter)
  }
  return formatter.format(value, unit)
}
