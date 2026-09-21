import { routeSearchProviders, type SearchContext, type SearchProvider, type SearchRegistry, type SearchResult } from './contract.js'

export interface SearchGroup {
  readonly id: string
  readonly label: string
  readonly status: 'loading' | 'ready' | 'error'
  readonly results: readonly SearchResult[]
}

export interface SearchSessionOptions {
  readonly registry: SearchRegistry
  readonly context: (signal: AbortSignal) => Omit<SearchContext, 'signal'>
  readonly boost?: (provider: SearchProvider, result: SearchResult) => number
  readonly debounceMs?: number
  readonly onReset?: () => void
  readonly onGroups: (groups: readonly SearchGroup[]) => void
}

export interface SearchSession {
  query(raw: string): void
  dispose(): void
}

/** Framework-free orchestration for every host of a SearchRegistry. */
export function createSearchSession(options: SearchSessionOptions): SearchSession {
  let raw = ''
  let generation = 0
  let controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let groups: readonly SearchGroup[] = []
  let disposed = false

  const clearTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const ranked = (provider: SearchProvider, results: readonly SearchResult[]): readonly SearchResult[] => {
    if (results.length === 0) return []
    const scores = results.map((item) => item.score)
    const min = Math.min(...scores)
    const range = Math.max(...scores) - min
    const normalized = (score: number): number => range === 0 ? 1 : (score - min) / range
    return [...results].sort((a, b) =>
      (normalized(b.score) + (options.boost?.(provider, b) ?? 0))
      - (normalized(a.score) + (options.boost?.(provider, a) ?? 0)),
    )
  }
  const run = (value: string): void => {
    if (disposed) return
    raw = value
    controller.abort()
    clearTimer()
    controller = new AbortController()
    const mine = ++generation
    groups = []
    options.onReset?.()
    options.onGroups(groups)
    const context: SearchContext = { ...options.context(controller.signal), signal: controller.signal }
    const route = routeSearchProviders(value, options.registry.list())
    const update = (
      provider: SearchProvider,
      status: SearchGroup['status'],
      results: readonly SearchResult[] = [],
    ): void => {
      if (disposed || mine !== generation || context.signal.aborted) return
      const group = {
        id: provider.id,
        label: provider.label,
        status,
        results: status === 'ready' ? ranked(provider, results) : [],
      }
      groups = [...groups.filter((item) => item.id !== provider.id), group]
        .sort((a, b) => route.providers.findIndex((provider) => provider.id === a.id) - route.providers.findIndex((provider) => provider.id === b.id))
      options.onGroups(groups)
    }
    const invoke = (provider: SearchProvider): void => {
      if (context.signal.aborted) return
      try {
        const output = provider.query(route.query, context)
        if (Array.isArray(output)) update(provider, 'ready', output)
        else {
          update(provider, 'loading')
          void Promise.resolve(output)
            .then(
              (items) => update(provider, 'ready', items),
              () => update(provider, 'error'),
            )
        }
      } catch {
        update(provider, 'error')
      }
    }
    for (const provider of route.providers.filter((provider) => !provider.async)) invoke(provider)
    const asyncProviders = route.providers.filter((provider) => provider.async)
    if (asyncProviders.length > 0) {
      for (const provider of asyncProviders) update(provider, 'loading')
      timer = setTimeout(() => {
        timer = undefined
        for (const provider of asyncProviders) invoke(provider)
      }, options.debounceMs ?? 120)
    }
  }
  const unsubscribe = options.registry.subscribe(() => run(raw))
  return {
    query: run,
    dispose() {
      if (disposed) return
      disposed = true
      generation++
      controller.abort()
      clearTimer()
      unsubscribe()
    },
  }
}
