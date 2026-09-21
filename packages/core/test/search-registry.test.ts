import { describe, expect, it, vi } from 'vitest'
import { createSearchRegistry, createSearchSession, type SearchContext, type SearchProvider, type SearchResult } from '../src/index.js'

const context = (signal = new AbortController().signal): SearchContext => ({ selection: { nodes: [] }, signal })
const provider = (id: string, prefix?: string): SearchProvider => ({
  id, label: id, ...(prefix !== undefined ? { prefix } : {}), priority: id === 'high' ? 10 : 0,
  query: vi.fn((q: string) => [{
    id: q, title: q, score: 1,
    action: { kind: 'host' as const, action: 'settings.open' as const, params: { category: id } },
  }]),
})

describe('SearchRegistry', () => {
  it('registers, lists in priority order, and unregisters duplicate-safely', () => {
    const registry = createSearchRegistry(); const low = provider('low'); const high = provider('high')
    registry.register(low); const remove = registry.register(high)
    expect(registry.list().map((p) => p.id)).toEqual(['high', 'low'])
    expect(() => registry.register(low)).toThrow(/already registered/)
    remove(); expect(registry.list().map((p) => p.id)).toEqual(['low'])
  })
  it('queries all providers and routes a declared prefix with it stripped', () => {
    const registry = createSearchRegistry(); const commands = provider('commands', '>'); const nodes = provider('nodes', '@')
    registry.register(commands); registry.register(nodes)
    expect(registry.query('hello', context())).toHaveLength(2)
    expect(registry.query('>  save', context()).map((r) => [r.provider.id, r.query])).toEqual([['commands', 'save']])
  })
  it('does not invoke providers for an already-aborted request', () => {
    const registry = createSearchRegistry(); const p = provider('one'); registry.register(p)
    const controller = new AbortController(); controller.abort()
    expect(registry.query('', context(controller.signal))).toEqual([])
    expect(p.query).not.toHaveBeenCalled()
  })
  it('passes the abort signal to a pending provider so it can observe cancellation', async () => {
    const registry = createSearchRegistry(); const controller = new AbortController(); let observed = false
    registry.register({ id: 'pending', label: 'Pending', priority: 0, async: true, query: (_query, ctx) => new Promise((resolve) => {
      ctx.signal.addEventListener('abort', () => { observed = true; resolve([]) }, { once: true })
    }) })
    const request = registry.query('wait', context(controller.signal))[0]!
    controller.abort(); await request.results
    expect(observed).toBe(true)
  })
  it('notifies once for provider registration and idempotent unregistration', () => {
    const registry = createSearchRegistry(); const changed = vi.fn(); const stop = registry.subscribe(changed)
    const remove = registry.register(provider('one'))
    remove(); const replacement = provider('one'); const removeReplacement = registry.register(replacement)
    remove()
    expect(registry.list()).toEqual([replacement])
    removeReplacement(); stop(); registry.register(provider('two'))
    expect(changed).toHaveBeenCalledTimes(4)
  })
  it('publishes a committed registry batch once and keeps rolled-back changes invisible', () => {
    const registry = createSearchRegistry(); const changed = vi.fn(); registry.subscribe(changed)
    const finishRollback = registry.beginBatch(); const remove = registry.register(provider('temporary'))
    remove(); finishRollback(false); finishRollback(false)
    expect(changed).not.toHaveBeenCalled()
    const finishCommit = registry.beginBatch(); registry.register(provider('published')); registry.register(provider('second'))
    expect(changed).not.toHaveBeenCalled()
    finishCommit(true)
    expect(changed).toHaveBeenCalledTimes(1)
  })
  it('keeps nested commit decisions independent and publishes their final state once', () => {
    const registry = createSearchRegistry(); const changed = vi.fn(); registry.subscribe(changed)
    const outerCommit = registry.beginBatch()
    const innerRollback = registry.beginBatch(); const removeRolledBack = registry.register(provider('rolled-back'))
    removeRolledBack(); innerRollback(false); innerRollback(true); outerCommit(true)
    expect(registry.list()).toEqual([])
    expect(changed).not.toHaveBeenCalled()

    const outerRollback = registry.beginBatch(); const removeOuter = registry.register(provider('outer'))
    const innerCommit = registry.beginBatch(); registry.register(provider('nested')); innerCommit(true)
    removeOuter(); outerRollback(false)
    expect(registry.list().map((item) => item.id)).toEqual(['nested'])
    expect(changed).toHaveBeenCalledTimes(1)
  })
  it('requires nested batches to finish in reverse order without poisoning later completion', () => {
    const registry = createSearchRegistry(); const changed = vi.fn(); registry.subscribe(changed)
    const outer = registry.beginBatch(); const inner = registry.beginBatch()
    expect(() => outer(true)).toThrow('reverse order')
    registry.register(provider('nested'))
    inner(true); inner(false); outer(true); outer(false)
    expect(registry.list().map((item) => item.id)).toEqual(['nested'])
    expect(changed).toHaveBeenCalledTimes(1)
  })
  it('isolates throwing change subscribers so registration still returns a usable disposer', () => {
    const registry = createSearchRegistry(); const later = vi.fn(); const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    registry.subscribe(() => { throw new Error('subscriber failed') })
    registry.subscribe(later)
    const remove = registry.register(provider('one'))
    expect(later).toHaveBeenCalledTimes(1)
    remove()
    expect(registry.list()).toEqual([])
    expect(later).toHaveBeenCalledTimes(2)
    error.mockRestore()
  })
})

const row = (id: string, score: number): SearchResult => ({
  id, title: id, score,
  action: { kind: 'host', action: 'settings.open', params: { category: 'test' } },
})

describe('SearchSession', () => {
  it('routes prefixes, normalizes provider-local scores, and applies an injected boost', () => {
    const registry = createSearchRegistry(); const calls: string[] = []; let latest: readonly SearchResult[] = []
    registry.register({ id: 'commands', label: 'Commands', prefix: '>', priority: 2, query: (query) => { calls.push(`commands:${query}`); return [row('plain', 1000), row('boosted', 1000)] } })
    registry.register({ id: 'tabs', label: 'Tabs', priority: 1, query: (query) => { calls.push(`tabs:${query}`); return [] } })
    const session = createSearchSession({
      registry, context: () => ({ selection: { nodes: [] } }),
      boost: (_provider, result) => result.id === 'boosted' ? 0.05 : 0,
      onGroups: (groups) => { latest = groups[0]?.results ?? [] },
    })
    session.query('> save')
    expect(calls).toEqual(['commands:save'])
    expect(latest.map((item) => item.id)).toEqual(['boosted', 'plain'])
    session.dispose()
  })

  it('renders sync groups immediately, publishes async state, debounces providers, and aborts stale queries', async () => {
    vi.useFakeTimers(); const registry = createSearchRegistry(); const signals: AbortSignal[] = []; const snapshots: string[][] = []; const resolveAsync: Array<(rows: readonly SearchResult[]) => void> = []
    registry.register({ id: 'async', label: 'Async', priority: 2, async: true, query: (_query, context) => { signals.push(context.signal); return new Promise((resolve) => resolveAsync.push(resolve)) } })
    registry.register({ id: 'sync', label: 'Sync', priority: 1, query: (query) => [row(`sync-${query}`, 1)] })
    const session = createSearchSession({ registry, context: () => ({ selection: { nodes: [] } }), onGroups: (groups) => snapshots.push(groups.map((group) => `${group.id}:${group.status}`)) })
    session.query('first')
    expect(snapshots.at(-1)).toEqual(['async:loading', 'sync:ready'])
    await vi.advanceTimersByTimeAsync(120)
    session.query('second')
    expect(signals[0]?.aborted).toBe(true)
    resolveAsync[0]?.([row('stale', 1)])
    await Promise.resolve()
    expect(snapshots.at(-1)).toEqual(['async:loading', 'sync:ready'])
    await vi.advanceTimersByTimeAsync(120)
    resolveAsync[1]?.([row('fresh', 1)])
    await Promise.resolve()
    expect(snapshots.at(-1)).toEqual(['async:ready', 'sync:ready'])
    session.dispose(); vi.useRealTimers()
  })

  it('isolates synchronous and asynchronous provider failures as host-renderable state', async () => {
    vi.useFakeTimers(); const registry = createSearchRegistry(); let latest: readonly string[] = []
    registry.register({ id: 'rejecting', label: 'Rejecting', priority: 3, async: true, query: async () => { throw new Error('private failure') } })
    registry.register({ id: 'throwing', label: 'Throwing', priority: 2, query: () => { throw new Error('private failure') } })
    registry.register({ id: 'healthy', label: 'Healthy', priority: 1, query: () => [row('working', 1)] })
    const session = createSearchSession({
      registry,
      context: () => ({ selection: { nodes: [] } }),
      onGroups: (groups) => { latest = groups.map((group) => `${group.id}:${group.status}:${group.results.length}`) },
    })
    session.query('open')
    expect(latest).toEqual(['rejecting:loading:0', 'throwing:error:0', 'healthy:ready:1'])
    await vi.advanceTimersByTimeAsync(120)
    await Promise.resolve()
    expect(latest).toEqual(['rejecting:error:0', 'throwing:error:0', 'healthy:ready:1'])
    session.dispose(); vi.useRealTimers()
  })

  it('re-queries an open session when providers register or unregister', () => {
    const registry = createSearchRegistry(); const snapshots: string[][] = []
    const session = createSearchSession({ registry, context: () => ({ selection: { nodes: [] } }), onGroups: (groups) => snapshots.push(groups.map((group) => group.id)) })
    session.query('open')
    const remove = registry.register({ id: 'runtime', label: 'Runtime', priority: 1, query: (query) => [row(query, 1)] })
    expect(snapshots.at(-1)).toEqual(['runtime'])
    remove()
    expect(snapshots.at(-1)).toEqual([])
    session.dispose()
  })
})
