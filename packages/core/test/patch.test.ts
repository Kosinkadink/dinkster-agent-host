/**
 * Patch engine + transaction builder tests. Contract guards under test:
 * - apply(inverse) restores the exact prior document (property-based)
 * - application is immutable with structural sharing
 * - ops survive JSON serialization (IPC/sync-log shape)
 * - the builder records correct forward/inverse pairs against a working copy
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Json, JsonObject, WorkflowDocument } from '../src/format/document.js'
import {
  applyOps,
  applyOwnedOps,
  getAtPath,
  invertOps,
  PatchError,
  type PatchOp,
} from '../src/commands/patch.js'
import { createTransactionBuilder } from '../src/commands/contract.js'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/workflows')
const subgraphDoc = (): WorkflowDocument =>
  JSON.parse(readFileSync(join(fixturesDir, 'subgraph.json'), 'utf8')) as WorkflowDocument

describe('applyOps', () => {
  const base: Json = {
    values: { a: 1, b: 'x' },
    list: [1, 2, 3],
    nested: { deep: { flag: true } },
  }

  it('adds, replaces and removes object keys', () => {
    const out = applyOps(base, [
      { op: 'add', path: ['values', 'c'], value: 3 },
      { op: 'replace', path: ['values', 'a'], value: 42, oldValue: 1 },
      { op: 'remove', path: ['values', 'b'], oldValue: 'x' },
    ]) as JsonObject
    expect(out['values']).toEqual({ a: 42, c: 3 })
  })

  it('inserts, replaces and removes array elements', () => {
    const out = applyOps(base, [
      { op: 'add', path: ['list', 1], value: 99 },
      { op: 'replace', path: ['list', 0], value: 0, oldValue: 1 },
      { op: 'remove', path: ['list', 2], oldValue: 2 },
    ]) as JsonObject
    expect(out['list']).toEqual([0, 99, 3])
  })

  it('appends via index == length', () => {
    const out = applyOps(base, [{ op: 'add', path: ['list', 3], value: 4 }]) as JsonObject
    expect(out['list']).toEqual([1, 2, 3, 4])
  })

  it('is immutable with structural sharing of untouched subtrees', () => {
    const out = applyOps(base, [
      { op: 'replace', path: ['values', 'a'], value: 2, oldValue: 1 },
    ]) as JsonObject
    const baseObj = base as JsonObject
    expect(baseObj['values']).toEqual({ a: 1, b: 'x' }) // original untouched
    expect(out['nested']).toBe(baseObj['nested']) // untouched subtree shared
    expect(out['list']).toBe(baseObj['list'])
    expect(out['values']).not.toBe(baseObj['values'])
  })

  it('rejects ops that do not fit the document', () => {
    const cases: readonly PatchOp[] = [
      { op: 'add', path: ['values', 'a'], value: 0 }, // already exists
      { op: 'remove', path: ['values', 'zz'], oldValue: null }, // missing
      { op: 'replace', path: ['values', 'zz'], value: 0, oldValue: null }, // missing
      { op: 'add', path: ['list', 99], value: 0 }, // out of bounds
      { op: 'replace', path: ['nested', 'deep', 'flag', 'x'], value: 0, oldValue: null }, // through a leaf
    ]
    for (const op of cases) {
      expect(() => applyOps(base, [op]), JSON.stringify(op)).toThrow(PatchError)
    }
  })

  it('ops survive JSON round-trips', () => {
    const ops: readonly PatchOp[] = [
      { op: 'add', path: ['values', 'c'], value: { nested: [1, 'two'] } },
      { op: 'remove', path: ['list', 0], oldValue: 1 },
    ]
    const revived = JSON.parse(JSON.stringify(ops)) as readonly PatchOp[]
    expect(applyOps(base, revived)).toEqual(applyOps(base, ops))
  })
})

describe('inverse round-trip (property-based)', () => {
  // Random edit programs against a small document shape, driven through the
  // builder so every forward op gets a recorded inverse.
  const keyArb = fc.constantFrom('a', 'b', 'c', 'd')
  const valueArb: fc.Arbitrary<Json> = fc.oneof(
    fc.integer(),
    fc.string(),
    fc.boolean(),
    fc.constant(null),
  )
  const editArb = fc.oneof(
    fc.record({ kind: fc.constant('set' as const), key: keyArb, value: valueArb }),
    fc.record({ kind: fc.constant('remove' as const), key: keyArb }),
    fc.record({ kind: fc.constant('push' as const), value: valueArb }),
    fc.record({ kind: fc.constant('pop' as const) }),
  )

  it('applying the inverse restores the exact document', () => {
    fc.assert(
      fc.property(fc.array(editArb, { maxLength: 25 }), (edits) => {
        const doc = subgraphDoc()
        const before = JSON.parse(JSON.stringify(doc)) as Json
        const tx = createTransactionBuilder(doc)
        for (const edit of edits) {
          const valuesPath = ['graphs', 'g0', 'nodes', 'n0', 'values']
          const netsPath = ['graphs', 'g1', 'nets', 'net4', 'sinks']
          const cur = tx.current as unknown as JsonObject
          if (edit.kind === 'set') {
            tx.set([...valuesPath, edit.key], edit.value)
          } else if (edit.kind === 'remove') {
            const values = getAtPath(cur, valuesPath) as JsonObject
            if (edit.key in values) tx.remove([...valuesPath, edit.key])
          } else if (edit.kind === 'push') {
            const sinks = getAtPath(cur, netsPath) as readonly Json[]
            tx.insert([...netsPath, sinks.length], edit.value)
          } else {
            const sinks = getAtPath(cur, netsPath) as readonly Json[]
            if (sinks.length > 0) tx.remove([...netsPath, sinks.length - 1])
          }
        }
        const { doc: after, forward, inverse } = tx.result()
        // Forward replay from the pristine document reproduces the result.
        expect(applyOps(before, forward)).toEqual(after)
        // Inverse replay restores the pristine document exactly.
        expect(applyOps(after as unknown as Json, inverse)).toEqual(before)
      }),
    )
  })

  it('invertOps is an involution', () => {
    const ops: readonly PatchOp[] = [
      { op: 'add', path: ['a'], value: 1 },
      { op: 'replace', path: ['b'], value: 2, oldValue: 0 },
      { op: 'remove', path: ['c'], oldValue: 3 },
    ]
    expect(invertOps(invertOps(ops))).toEqual(ops)
  })
})

describe('transaction builder', () => {
  it('set records add for new keys and replace for existing ones', () => {
    const tx = createTransactionBuilder(subgraphDoc())
    tx.set(['graphs', 'g0', 'nodes', 'n0', 'values', 'width'], 1024) // exists
    tx.set(['graphs', 'g0', 'nodes', 'n0', 'values', 'newKey'], 'v') // new
    expect(tx.forward[0]!.op).toBe('replace')
    expect(tx.forward[1]!.op).toBe('add')
  })

  it('later reads see earlier writes within one transaction', () => {
    const tx = createTransactionBuilder(subgraphDoc())
    tx.set(['graphs', 'g0', 'nodes', 'n0', 'values', 'width'], 2048)
    const cur = tx.current as unknown as JsonObject
    expect(getAtPath(cur, ['graphs', 'g0', 'nodes', 'n0', 'values', 'width'])).toBe(2048)
    tx.set(['graphs', 'g0', 'nodes', 'n0', 'values', 'width'], 4096)
    const { forward } = tx.result()
    // Second set records the intermediate value as oldValue, not the original.
    expect(forward[1]).toMatchObject({ op: 'replace', oldValue: 2048, value: 4096 })
  })

  it('does not mutate the input document', () => {
    const doc = subgraphDoc()
    const snapshot = JSON.parse(JSON.stringify(doc))
    const tx = createTransactionBuilder(doc)
    tx.set(['meta', 'title'], 'changed')
    tx.remove(['graphs', 'g0', 'nodes', 'n2'])
    tx.result()
    expect(doc).toEqual(snapshot)
  })
})

describe('CO2 prototype-chain safety', () => {
  it('getAtPath never reads the prototype chain', () => {
    expect(getAtPath({ a: 1 }, ['constructor'])).toBeUndefined()
    expect(getAtPath({ a: 1 }, ['__proto__'])).toBeUndefined()
    expect(getAtPath({ a: 1 }, ['hasOwnProperty'])).toBeUndefined()
  })

  it('getAtPath never reads array holes or polluted Array.prototype indices', () => {
    ;(Array.prototype as unknown as Record<number, unknown>)[7] = 'polluted'
    try {
      expect(getAtPath([1], [7])).toBeUndefined()
      // eslint-disable-next-line no-sparse-arrays
      expect(getAtPath([1, , 3] as unknown as Json, [1])).toBeUndefined()
    } finally {
      delete (Array.prototype as unknown as Record<number, unknown>)[7]
    }
  })

  it('applyOps refuses to traverse into an inherited array element', () => {
    ;(Array.prototype as unknown as Record<number, unknown>)[7] = { x: 1 }
    try {
      expect(() =>
        applyOps([1] as Json, [{ op: 'replace', path: [7, 'x'], value: 2, oldValue: 1 }]),
      ).toThrow(PatchError)
    } finally {
      delete (Array.prototype as unknown as Record<number, unknown>)[7]
    }
  })

  it("applyOps rejects a '__proto__' path segment (wire/replay defense in depth)", () => {
    // A '__proto__' key is exactly what ownJson forbids in documents; a
    // patch must never be able to create one either (add), replace through
    // one, or traverse one - regardless of where the op came from.
    expect(() =>
      applyOps({} as Json, [{ op: 'add', path: ['__proto__'], value: { polluted: true } }]),
    ).toThrow(/__proto__/)
    expect(() =>
      applyOps({ a: 1 } as Json, [
        { op: 'replace', path: ['__proto__', 'x'], value: 9, oldValue: 1 },
      ]),
    ).toThrow(PatchError)
    expect(({}) as Record<string, unknown>).not.toHaveProperty('polluted')
  })

  it('applyOps rejects non-integer, negative, and unsafe array indices', () => {
    expect(() => applyOps([1, 2] as Json, [{ op: 'replace', path: [0.5], value: 9, oldValue: 1 }])).toThrow(PatchError)
    expect(() => applyOps([1, 2] as Json, [{ op: 'replace', path: [-1], value: 9, oldValue: 1 }])).toThrow(PatchError)
    expect(() => applyOps([1, 2] as Json, [{ op: 'replace', path: [NaN], value: 9, oldValue: 1 }])).toThrow(PatchError)
    expect(() => applyOps([1, 2] as Json, [{ op: 'replace', path: [2 ** 53], value: 9, oldValue: 1 }])).toThrow(PatchError)
  })

  it("applyOps object membership ignores inherited keys ('constructor' is not found)", () => {
    expect(() =>
      applyOps({ a: 1 } as Json, [{ op: 'replace', path: ['constructor'], value: 9, oldValue: 1 }]),
    ).toThrow(PatchError)
    expect(() =>
      applyOps({ a: 1 } as Json, [{ op: 'remove', path: ['constructor'], oldValue: 1 }]),
    ).toThrow(PatchError)
  })

  it('applyOps output containers are frozen', () => {
    const out = applyOps({ a: { b: 1 } } as Json, [
      { op: 'replace', path: ['a', 'b'], value: 2, oldValue: 1 },
    ]) as JsonObject
    expect(Object.isFrozen(out)).toBe(true)
    expect(Object.isFrozen(out['a'])).toBe(true)
  })
})

describe('applyOps foreign-op ingress (ownership at the patch boundary)', () => {
  it('detaches add/replace values: mutating the original never alters the result', () => {
    const value = { nested: { n: 1 }, list: [1] }
    const out = applyOps({} as Json, [
      { op: 'add', path: ['x'], value: value as unknown as Json },
    ]) as JsonObject
    value.nested.n = 999
    value.list.push(2)
    const installed = out['x'] as { nested: { n: number }; list: number[] }
    expect(installed.nested.n).toBe(1)
    expect(installed.list).toEqual([1])
    expect(Object.isFrozen(installed)).toBe(true)
    expect(Object.isFrozen(installed.nested)).toBe(true)
    expect(Object.isFrozen(installed.list)).toBe(true)
  })

  it('rejects hostile values: accessors, cycles, __proto__ keys', () => {
    const accessor: Record<string, unknown> = {}
    Object.defineProperty(accessor, 'a', { get: () => 1, enumerable: true })
    expect(() =>
      applyOps({} as Json, [{ op: 'add', path: ['x'], value: accessor as unknown as Json }]),
    ).toThrow(PatchError)

    const cyc: Record<string, unknown> = {}
    cyc['self'] = cyc
    expect(() =>
      applyOps({} as Json, [{ op: 'add', path: ['x'], value: cyc as unknown as Json }]),
    ).toThrow(PatchError)

    // JSON.parse mints an OWN '__proto__' property - exactly the wire shape.
    const proto = JSON.parse('{"__proto__": {"polluted": true}}') as Json
    expect(() => applyOps({} as Json, [{ op: 'add', path: ['x'], value: proto }])).toThrow(PatchError)
  })

  it('rejects non-string/number path segments (an object segment would coerce inside property access)', () => {
    const seg = { toString: () => 'a' } as unknown as string
    expect(() =>
      applyOps({ a: 1 } as Json, [{ op: 'replace', path: [seg], value: 2, oldValue: 1 }]),
    ).toThrow(PatchError)
  })

  it('rejects an unknown op discriminator instead of silently treating it as replace', () => {
    expect(() =>
      applyOps({ x: 1 } as Json, [{ op: 'bogus', path: ['x'], value: 2 } as unknown as PatchOp]),
    ).toThrow(PatchError)
    expect(() =>
      applyOps({ x: 1 } as Json, [{ op: 'move', path: ['x'], value: 2 } as unknown as PatchOp]),
    ).toThrow(PatchError)
  })

  it('rejects add/replace ops with no value property', () => {
    expect(() => applyOps({ x: 1 } as Json, [{ op: 'add', path: ['y'] } as unknown as PatchOp])).toThrow(PatchError)
    expect(() =>
      applyOps({ x: 1 } as Json, [{ op: 'replace', path: ['x'], oldValue: 1 } as unknown as PatchOp]),
    ).toThrow(PatchError)
  })

  it('owns the WHOLE op envelope: a hostile oldValue on a foreign remove is detached, and inverting it stays safe', () => {
    const hostile = { deep: { n: 1 } }
    const out = applyOps({ x: 5 } as Json, [
      { op: 'remove', path: ['x'], oldValue: hostile as unknown as Json },
    ]) as JsonObject
    expect(out['x']).toBeUndefined()
    // Inverting a foreign remove yields an add carrying oldValue; applied
    // through applyOps (public ingress, never the fast path) the value is
    // owned at THAT ingress, so mutating the original after application
    // can never reach the document.
    const inv = invertOps([{ op: 'remove', path: ['x'], oldValue: hostile as unknown as Json }])
    const restored = applyOps(out as Json, inv) as JsonObject
    hostile.deep.n = 999
    expect((restored['x'] as { deep: { n: number } }).deep.n).toBe(1)
    expect(Object.isFrozen(restored['x'])).toBe(true)
  })

  it('rejects a hostile Proxy around the ops ARRAY itself with a PatchError, not the trap error', () => {
    const target = [{ op: 'add', path: ['x'], value: 1 }]
    const hostile = new Proxy(target, {
      getOwnPropertyDescriptor() {
        throw new Error('hostile trap')
      },
    })
    expect(() => applyOps({} as Json, hostile)).toThrow(PatchError)
  })

  it('rejects a non-array ops batch', () => {
    expect(() => applyOps({} as Json, { op: 'add', path: ['x'], value: 1 })).toThrow(PatchError)
    expect(() => applyOps({} as Json, 'ops')).toThrow(PatchError)
  })

  it('rejects an accessor on the op ENVELOPE itself without invoking it', () => {
    let invoked = false
    const op: Record<string, unknown> = { op: 'add', path: ['x'] }
    Object.defineProperty(op, 'value', {
      get: () => {
        invoked = true
        return 1
      },
      enumerable: true,
    })
    expect(() => applyOps({} as Json, [op])).toThrow(PatchError)
    expect(invoked).toBe(false)
  })

  it('a hostile path segment with a throwing toString rejects as a PatchError (never runs inside error construction)', () => {
    const seg = {
      toString: () => {
        throw new Error('hostile toString')
      },
    }
    expect(() =>
      applyOps({ a: 1 } as Json, [{ op: 'replace', path: [seg], value: 2, oldValue: 1 }]),
    ).toThrow(PatchError)
  })

  it('rejects a cyclic oldValue on a foreign remove', () => {
    const cyc: Record<string, unknown> = {}
    cyc['self'] = cyc
    expect(() =>
      applyOps({ x: 1 } as Json, [{ op: 'remove', path: ['x'], oldValue: cyc }]),
    ).toThrow(PatchError)
  })

  it('budgets the batch as a WHOLE: ops individually under the node budget still reject cumulatively', () => {
    // One shared subtree, revisited per op: each op alone (~2.2M nodes) is
    // inside MAX_JSON_NODES (4M); two together are not. Per-op ownership
    // (the old shape) would admit this batch.
    const big = new Array(2_200_000).fill(0) as unknown as Json
    expect(() => applyOps({} as Json, [{ op: 'add', path: ['x'], value: big }])).not.toThrow()
    expect(() =>
      applyOps({} as Json, [
        { op: 'add', path: ['x'], value: big },
        { op: 'add', path: ['y'], value: big },
      ]),
    ).toThrow(PatchError)
  })

  it('applyOwnedOps is the TRUSTED fast path: owned values install by reference', () => {
    // The transaction builder owns (detaches + freezes) everything it
    // records; applyOwnedOps relies on that and skips re-validation.
    const value = Object.freeze({ n: 1 }) as unknown as Json
    const out = applyOwnedOps({} as Json, [{ op: 'add', path: ['x'], value }]) as JsonObject
    expect(out['x']).toBe(value)
  })
})
