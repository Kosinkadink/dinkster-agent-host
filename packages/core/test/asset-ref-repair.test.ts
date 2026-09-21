import { describe, expect, it } from 'vitest'
import {
  DocumentStore,
  coreCommandRegistry,
  planAssetRefRepair,
  type AssetRef,
  type AssetRefRepairSuggestion,
  type WorkflowDocument,
} from '../src/index.js'

const digest = (char: string) => `blake3:${char.repeat(64)}`
const oldRef: AssetRef = { digest: digest('a'), name: 'old.png', size: 10, mediaType: 'image/png', virtualPath: 'old.png' }
const newRef: AssetRef = { digest: digest('a'), name: 'new.png', size: 10, mediaType: 'image/png', virtualPath: 'managed/new.png' }
const otherRef: AssetRef = { digest: digest('b'), name: 'other.png', size: 20, mediaType: 'image/png', virtualPath: 'other.png' }

const document = (): WorkflowDocument => ({
  format: 'dinkster-workflow', formatVersion: 1, lineage: 'lineage' as never, root: 'g0' as never,
  graphs: { g0: {
    id: 'g0' as never, name: 'root', nextOrdinal: 10, links: {}, reroutes: {}, nets: {},
    nodes: {
      n0: { id: 'n0' as never, type: 'AssetNode', values: { asset: oldRef, assets: [oldRef, otherRef], text: 'not-an-asset' } },
      n1: { id: 'n1' as never, type: 'AssetNode', values: { asset: oldRef } },
    },
  } },
  view: { graphs: { g0: { nodes: { n0: { position: { x: 0, y: 0 } }, n1: { position: { x: 100, y: 0 } } } } } },
})

const suggestion = (
  preconditions: AssetRefRepairSuggestion['preconditions'],
  replacements: AssetRefRepairSuggestion['replacements'],
  documentDigest = 'session:7',
): AssetRefRepairSuggestion => ({
  type: 'asset-ref-repair', version: 1, atomic: true, documentDigest, preconditions, replacements,
})

describe('asset ref repair planner', () => {
  it('plans one atomic batch, advances once, and one undo restores every value', () => {
    const store = new DocumentStore(document(), coreCommandRegistry())
    const repair = suggestion(
      [
        { pointer: '/graphs/g0/nodes/n0/values/asset', equals: oldRef },
        { pointer: '/graphs/g0/nodes/n1/values/asset', equals: oldRef },
      ],
      [
        { pointer: '/graphs/g0/nodes/n0/values/asset', value: newRef },
        { pointer: '/graphs/g0/nodes/n1/values/asset', value: newRef },
      ],
    )
    const plan = planAssetRefRepair(repair, 'session:7', store.doc)
    expect(plan).toMatchObject({ ok: true, invocation: { command: 'batch' } })
    if (!plan.ok) return
    expect(store.dispatch(plan.invocation).ok).toBe(true)
    expect(store.revision).toBe(1)
    expect(store.doc.graphs.g0!.nodes.n0!.values.asset).toEqual(newRef)
    expect(store.doc.graphs.g0!.nodes.n1!.values.asset).toEqual(newRef)
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.g0!.nodes.n0!.values.asset).toEqual(oldRef)
    expect(store.doc.graphs.g0!.nodes.n1!.values.asset).toEqual(oldRef)
  })

  it('addresses AssetRef list elements and combines writes to one widget', () => {
    const repair = suggestion(
      [
        { pointer: '/graphs/g0/nodes/n0/values/assets/0', equals: oldRef },
        { pointer: '/graphs/g0/nodes/n0/values/assets/1', equals: otherRef },
      ],
      [
        { pointer: '/graphs/g0/nodes/n0/values/assets/0', value: newRef },
        { pointer: '/graphs/g0/nodes/n0/values/assets/1', value: oldRef },
      ],
    )
    const store = new DocumentStore(document(), coreCommandRegistry())
    const plan = planAssetRefRepair(repair, 'session:7', store.doc)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(store.dispatch(plan.invocation).ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes.n0!.values.assets).toEqual([newRef, oldRef])
  })

  it('keeps graph and node tuple grouping injective when ids contain NUL', () => {
    const doc = document()
    const graphOne = { ...doc.graphs.g0!, id: 'a\0b' as never, nodes: { c: { id: 'c' as never, type: 'AssetNode', values: { asset: oldRef } } } }
    const graphTwo = { ...doc.graphs.g0!, id: 'a' as never, nodes: { ['b\0c']: { id: 'b\0c' as never, type: 'AssetNode', values: { asset: oldRef } } } }
    const withNul = { ...doc, graphs: { ['a\0b']: graphOne, a: graphTwo } }
    const repair = suggestion(
      [
        { pointer: '/graphs/a\0b/nodes/c/values/asset', equals: oldRef },
        { pointer: '/graphs/a/nodes/b\0c/values/asset', equals: oldRef },
      ],
      [
        { pointer: '/graphs/a\0b/nodes/c/values/asset', value: newRef },
        { pointer: '/graphs/a/nodes/b\0c/values/asset', value: newRef },
      ],
    )
    const plan = planAssetRefRepair(repair, 'session:7', withNul)
    expect(plan.ok).toBe(true)
    if (plan.ok) expect((plan.invocation.params as { invocations: unknown[] }).invocations).toHaveLength(2)
  })

  it('plans a list element whose input id shadows Object.prototype', () => {
    const doc = document()
    const n0 = doc.graphs.g0!.nodes.n0!
    const withConstructor = {
      ...doc,
      graphs: { g0: { ...doc.graphs.g0!, nodes: { ...doc.graphs.g0!.nodes, n0: { ...n0, values: { constructor: [oldRef] } } } } },
    }
    const repair = suggestion(
      [{ pointer: '/graphs/g0/nodes/n0/values/constructor/0', equals: oldRef }],
      [{ pointer: '/graphs/g0/nodes/n0/values/constructor/0', value: newRef }],
    )
    expect(planAssetRefRepair(repair, 'session:7', withConstructor).ok).toBe(true)
  })

  it.each([
    ['digest mismatch', suggestion([{ pointer: '/graphs/g0/nodes/n0/values/asset', equals: oldRef }], [{ pointer: '/graphs/g0/nodes/n0/values/asset', value: newRef }], 'other'), 'document-digest-mismatch'],
    ['stale precondition', suggestion([{ pointer: '/graphs/g0/nodes/n0/values/asset', equals: otherRef }], [{ pointer: '/graphs/g0/nodes/n0/values/asset', value: newRef }]), 'stale-precondition'],
    ['missing node', suggestion([{ pointer: '/graphs/g0/nodes/missing/values/asset', equals: oldRef }], [{ pointer: '/graphs/g0/nodes/missing/values/asset', value: newRef }]), 'target-missing'],
    ['type mismatch', suggestion([{ pointer: '/graphs/g0/nodes/n0/values/text', equals: oldRef }], [{ pointer: '/graphs/g0/nodes/n0/values/text', value: newRef }]), 'current-value-invalid'],
    ['empty preconditions', suggestion([], [{ pointer: '/graphs/g0/nodes/n0/values/asset', value: newRef }]), 'empty-repair'],
    ['empty replacements', suggestion([{ pointer: '/graphs/g0/nodes/n0/values/asset', equals: oldRef }], []), 'empty-repair'],
    ['unchecked replacement', suggestion([{ pointer: '/graphs/g0/nodes/n0/values/asset', equals: oldRef }], [{ pointer: '/graphs/g0/nodes/n1/values/asset', value: newRef }]), 'precondition-target-mismatch'],
    ['no-op repair', suggestion([{ pointer: '/graphs/g0/nodes/n0/values/asset', equals: oldRef }], [{ pointer: '/graphs/g0/nodes/n0/values/asset', value: oldRef }]), 'no-op-repair'],
    ['inherited node', suggestion([{ pointer: '/graphs/g0/nodes/constructor/values/asset', equals: oldRef }], [{ pointer: '/graphs/g0/nodes/constructor/values/asset', value: newRef }]), 'target-missing'],
    ['inherited input', suggestion([{ pointer: '/graphs/g0/nodes/n0/values/constructor', equals: oldRef }], [{ pointer: '/graphs/g0/nodes/n0/values/constructor', value: newRef }]), 'target-missing'],
  ] as const)('rejects %s without mutation', (_label, repair, code) => {
    const doc = document()
    const before = JSON.stringify(doc)
    const plan = planAssetRefRepair(repair, 'session:7', doc)
    expect(plan).toEqual(expect.objectContaining({ ok: false, code }))
    expect(JSON.stringify(doc)).toBe(before)
  })

  it.each([
    suggestion(
      [{ pointer: '/graphs/g0/nodes/n0/values/assets', equals: oldRef }],
      [
        { pointer: '/graphs/g0/nodes/n0/values/assets', value: newRef },
        { pointer: '/graphs/g0/nodes/n0/values/assets/0', value: newRef },
      ],
    ),
    suggestion(
      [
        { pointer: '/graphs/g0/nodes/n0/values/asset', equals: oldRef },
        { pointer: '/graphs/g0/nodes/n0/values/asset', equals: oldRef },
      ],
      [
        { pointer: '/graphs/g0/nodes/n0/values/asset', value: newRef },
        { pointer: '/graphs/g0/nodes/n0/values/asset', value: otherRef },
      ],
    ),
  ])('rejects duplicate or overlapping targets', (repair) => {
    expect(planAssetRefRepair(repair, 'session:7', document())).toEqual(expect.objectContaining({ ok: false, code: 'overlapping-targets' }))
  })
})
