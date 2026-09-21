/**
 * ownJson / jsonWithinBudget is the single ownership + JSON-semantics
 * boundary. These tests pin hostile-input hardening: prototype pollution,
 * accessors, proxies, sparse arrays, cycles, and undefined-property modes.
 */
import { describe, expect, it } from 'vitest'
import { MAX_JSON_DEPTH, MAX_JSON_NODES, ownJson } from '../src/format/json.js'

describe('ownJson', () => {
  it('returns an owned deep-frozen copy detached from the input', () => {
    const input = { a: { b: [1, 2] } }
    const out = ownJson(input)
    if (!out.ok) throw new Error(out.reason)
    input.a.b.push(3)
    expect(out.value).toEqual({ a: { b: [1, 2] } })
    expect(Object.isFrozen(out.value)).toBe(true)
    expect(Object.isFrozen((out.value as { a: unknown }).a)).toBe(true)
    expect(Object.isFrozen((out.value as { a: { b: unknown } }).a.b)).toBe(true)
  })

  it('rejects cyclic values instead of recursing forever', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const out = ownJson(cyclic)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('cyclic')
  })

  it('allows the SAME object twice on different branches (DAG, not cycle)', () => {
    const shared = { x: 1 }
    const out = ownJson({ a: shared, b: shared })
    expect(out.ok).toBe(true)
  })

  it('rejects non-finite numbers, functions, symbols, bigints, class instances', () => {
    expect(ownJson({ v: Infinity }).ok).toBe(false)
    expect(ownJson({ v: NaN }).ok).toBe(false)
    expect(ownJson({ v: () => 1 }).ok).toBe(false)
    expect(ownJson({ v: Symbol('s') }).ok).toBe(false)
    expect(ownJson({ v: 1n }).ok).toBe(false)
    expect(ownJson({ v: new Date() }).ok).toBe(false)
    expect(ownJson({ v: new Map() }).ok).toBe(false)
  })

  it('rejects trees nested past the depth budget', () => {
    let deep: unknown = 1
    for (let i = 0; i <= MAX_JSON_DEPTH; i++) deep = [deep]
    const out = ownJson(deep)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('deeper')
  })

  it("rejects a JSON-parsed '__proto__' key instead of polluting the copy's prototype", () => {
    const input: unknown = JSON.parse('{"__proto__": {"polluted": 1}}')
    const out = ownJson(input)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('__proto__')
    // And the global prototype was never touched.
    expect(({} as { polluted?: number }).polluted).toBeUndefined()
  })

  it('rejects getter properties without invoking them', () => {
    let invoked = false
    const input = {}
    Object.defineProperty(input, 'trap', {
      enumerable: true,
      get() {
        invoked = true
        return 1
      },
    })
    const out = ownJson(input)
    expect(out.ok).toBe(false)
    expect(invoked).toBe(false)
  })

  it('converts a throwing Proxy trap into a rejection, never a throw', () => {
    const hostile = new Proxy({}, {
      ownKeys() {
        throw new Error('trap!')
      },
    })
    const out = ownJson({ v: hostile })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('reflection failed')
  })

  it('rejects sparse arrays (a hole would read Array.prototype)', () => {
    // eslint-disable-next-line no-sparse-arrays
    const out = ownJson([1, , 3])
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('sparse')
  })

  it('rejects undefined array elements', () => {
    expect(ownJson([1, undefined, 3]).ok).toBe(false)
  })

  it("drops undefined object properties by default (JSON.stringify semantics)", () => {
    const out = ownJson({ keep: 1, drop: undefined })
    if (!out.ok) throw new Error(out.reason)
    expect(out.value).toEqual({ keep: 1 })
  })

  it("rejects undefined object properties in 'reject' mode (command params)", () => {
    const out = ownJson({ keep: 1, bad: undefined }, { undefinedProps: 'reject' })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('undefined')
  })
})

describe('ownJson hostile diagnostics and number edges', () => {
  it('never invokes accessors while formatting a rejection (hostile thrown value)', () => {
    let invoked = false
    const bomb = Object.create(Error.prototype) as object
    Object.defineProperty(bomb, 'message', {
      get() {
        invoked = true
        return 'boom'
      },
    })
    const proxy = new Proxy({}, {
      getPrototypeOf() {
        throw bomb
      },
    })
    const out = ownJson({ p: proxy })
    expect(out.ok).toBe(false)
    expect(invoked).toBe(false)
  })

  it('normalizes -0 to 0 (JSON has no signed zero)', () => {
    const out = ownJson({ x: -0 })
    expect(out.ok).toBe(true)
    if (out.ok) expect(Object.is((out.value as { x: number }).x, 0)).toBe(true)
  })

  it('truncates a hostile thrown message instead of copying it into the diagnostic', () => {
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          // Plain own DATA property - safeErrorMessage may read it, but the
          // unbounded payload must not ride into the rejection reason.
          throw { message: 'x'.repeat(100_000) }
        },
      },
    )
    const out = ownJson({ p: proxy })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason.length).toBeLessThan(300)
  })
})

describe('ownJson budgets are total (work proportional to budget, never to input)', () => {
  it('rejects when string VALUES exceed the char budget', () => {
    const out = ownJson({ a: 'xxxxxxxxxx' }, { limits: { maxChars: 5 } })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('string characters')
  })

  it('object KEYS consume the char budget too', () => {
    const out = ownJson({ aVeryLongKeyName: 1 }, { limits: { maxChars: 5 } })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('string characters')
  })

  it('the char budget is cumulative across the whole tree', () => {
    // Each string fits alone; together they exceed the budget.
    const out = ownJson(['aaaa', 'bbbb', 'cccc'], { limits: { maxChars: 10 } })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('string characters')
  })

  it('dropped undefined properties still consume node budget (no free enumeration)', () => {
    const hostile: Record<string, undefined> = {}
    for (let i = 0; i < 20; i++) hostile[`k${i}`] = undefined
    const out = ownJson(hostile, { limits: { maxNodes: 10 } })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('JSON nodes')
  })

  it('an oversized object key list fails on the bulk check before crawling descriptors', () => {
    let descriptorReads = 0
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          return Array.from({ length: 50 }, (_, i) => `k${i}`)
        },
        getOwnPropertyDescriptor() {
          descriptorReads += 1
          return { value: 1, writable: true, enumerable: true, configurable: true }
        },
      },
    )
    const out = ownJson(proxy, { limits: { maxNodes: 10 } })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('JSON nodes')
    // Object.keys itself reads descriptors to filter enumerability; the
    // point is the per-key VISIT crawl never starts, so the count stays at
    // the enumeration pass instead of doubling.
    expect(descriptorReads).toBeLessThanOrEqual(50)
  })

  it('a lying Proxy array length fails cheap, before allocation or element crawling', () => {
    let elementReads = 0
    const target: unknown[] = []
    const proxy = new Proxy(target, {
      getOwnPropertyDescriptor(t, p) {
        if (p === 'length')
          // Target length is writable, so a proxy may legally report a
          // different value here.
          return { value: MAX_JSON_NODES + 10, writable: true, enumerable: false, configurable: false }
        elementReads += 1
        return Reflect.getOwnPropertyDescriptor(t, p)
      },
    })
    const out = ownJson([proxy]) // PRODUCTION budgets: must fail without 4M iterations
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('JSON nodes')
    expect(elementReads).toBe(0)
  })

  it('descriptors that vanish between the key pass and the read still consume budget', () => {
    // A Proxy can report keys during Object.keys() and then answer undefined
    // for the explicit descriptor read; each such slot must still be
    // charged, or repeated vanishing-key proxies enumerate for free.
    const vanishing = (keyCount: number) => {
      const served = new Set<string>()
      return new Proxy(
        {},
        {
          ownKeys: () => Array.from({ length: keyCount }, (_, i) => `k${i}`),
          getOwnPropertyDescriptor(_t, p) {
            if (typeof p !== 'string') return undefined
            if (served.has(p)) return undefined // vanished on the second read
            served.add(p)
            return { value: 1, writable: true, enumerable: true, configurable: true }
          },
        },
      )
    }
    // Charges: 1 (array) + 3 (proxies) + 15 (vanished slots) = 19 > 12.
    // Each proxy passes the bulk key check alone; only cumulative slot
    // charging catches the total.
    const out = ownJson([vanishing(5), vanishing(5), vanishing(5)], { limits: { maxNodes: 12 } })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('JSON nodes')
  })

  it('a non-integer array length is rejected outright', () => {
    const proxy = new Proxy([], {
      getOwnPropertyDescriptor(t, p) {
        if (p === 'length')
          return { value: 1.5, writable: true, enumerable: false, configurable: false }
        return Reflect.getOwnPropertyDescriptor(t, p)
      },
    })
    const out = ownJson(proxy)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('array length')
  })
})
