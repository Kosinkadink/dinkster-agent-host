import { beforeEach, describe, expect, it } from 'vitest'
import {
  activeLocale,
  formatDate,
  formatNumber,
  formatRelativeTime,
  loadCatalog,
  registerCatalog,
  setLocale,
  t,
  tPlural,
} from '../src/i18n/index.js'

const english = {
  greeting: 'Hello, {name}',
  items: '{count, plural, one {# item for {name}} other {# items for {name}}}',
  fallback: 'English fallback',
}

describe('i18n', () => {
  beforeEach(() => {
    registerCatalog('en', english)
    registerCatalog('zh', {})
    setLocale('en')
  })

  it('interpolates values and retains a missing parameter', () => {
    expect(t('greeting', { name: 'Ada' })).toBe('Hello, Ada')
    expect(t('greeting')).toBe('Hello, {name}')
  })

  it('selects plural categories with interpolation', () => {
    expect(tPlural('items', 1, { name: 'Ada' })).toBe('1 item for Ada')
    expect(tPlural('items', 2, { name: 'Ada' })).toBe('2 items for Ada')
  })

  it('falls back by base language, English, and then key', () => {
    registerCatalog('zh', { greeting: 'Ni hao, {name}' })
    setLocale('zh-CN')
    expect(t('greeting', { name: 'Ada' })).toBe('Ni hao, Ada')
    expect(t('fallback')).toBe('English fallback')
    expect(t('missing.key')).toBe('missing.key')
  })

  it('publishes canonical locale changes', () => {
    const seen: string[] = []
    const unsubscribe = activeLocale.subscribe((locale) => seen.push(locale.tag))
    setLocale('zh-cn')
    setLocale('zh-CN')
    unsubscribe()
    expect(activeLocale.get()).toEqual({ tag: 'zh-CN', dir: 'ltr' })
    expect(seen).toEqual(['zh-CN'])
  })

  it('publishes direction from the resolved writing script', () => {
    setLocale('ar-xb')
    expect(activeLocale.get()).toEqual({ tag: 'ar-XB', dir: 'rtl' })
    setLocale('ar-Latn')
    expect(activeLocale.get()).toEqual({ tag: 'ar-Latn', dir: 'ltr' })
    setLocale('en-Arab')
    expect(activeLocale.get()).toEqual({ tag: 'en-Arab', dir: 'rtl' })
  })

  it('covers every CLDR RTL script when Intl textInfo is unavailable', () => {
    const descriptor = Object.getOwnPropertyDescriptor(Intl.Locale.prototype, 'textInfo')
    Object.defineProperty(Intl.Locale.prototype, 'textInfo', { configurable: true, value: undefined })
    try {
      const rtlScripts = [
        'Adlm', 'Arab', 'Armi', 'Avst', 'Chrs', 'Cprt', 'Elym', 'Gara', 'Hatr',
        'Hebr', 'Hung', 'Khar', 'Lydi', 'Mand', 'Mani', 'Mend', 'Merc', 'Mero',
        'Narb', 'Nbat', 'Nkoo', 'Orkh', 'Ougr', 'Palm', 'Phli', 'Phlp', 'Phnx',
        'Prti', 'Rohg', 'Samr', 'Sarb', 'Sidt', 'Sogd', 'Sogo', 'Syrc', 'Thaa',
        'Yezi',
      ]
      for (const script of rtlScripts) {
        setLocale(`en-${script}`)
        expect(activeLocale.get().dir, script).toBe('rtl')
      }
      setLocale('ar-Latn')
      expect(activeLocale.get().dir).toBe('ltr')
    } finally {
      if (descriptor === undefined) {
        delete (Intl.Locale.prototype as unknown as Record<string, unknown>)['textInfo']
      } else {
        Object.defineProperty(Intl.Locale.prototype, 'textInfo', descriptor)
      }
    }
  })

  it('loads a catalog once', async () => {
    let calls = 0
    await loadCatalog('fr', async () => {
      calls++
      return { greeting: 'Bonjour, {name}' }
    })
    await loadCatalog('fr', async () => {
      calls++
      return {}
    })
    setLocale('fr')
    expect(t('greeting', { name: 'Ada' })).toBe('Bonjour, Ada')
    expect(calls).toBe(1)
  })

  it('binds all Intl wrappers to the active locale', () => {
    setLocale('en-US')
    expect(formatNumber(1234.5)).toBe('1,234.5')
    expect(formatDate(new Date(Date.UTC(2026, 0, 2)), { timeZone: 'UTC', dateStyle: 'medium' })).toBe('Jan 2, 2026')
    expect(formatRelativeTime(-1, 'day', { numeric: 'auto' })).toBe('yesterday')

    setLocale('zh-CN')
    expect(formatNumber(1234.5)).toBe('1,234.5')
    expect(formatDate(new Date(Date.UTC(2026, 0, 2)), { timeZone: 'UTC', dateStyle: 'medium' })).toBe('2026\u5e741\u67082\u65e5')
    expect(formatRelativeTime(-1, 'day', { numeric: 'auto' })).toBe('\u6628\u5929')

    setLocale('de-DE')
    expect(formatNumber(1234.5)).toBe('1.234,5')
  })
})
