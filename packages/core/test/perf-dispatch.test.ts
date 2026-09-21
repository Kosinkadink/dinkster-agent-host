/**
 * Dispatch-path performance record for the hottest write path in the app:
 * dispatch -> transaction builder -> applyOps -> commit -> notify. These
 * timings keep before/after numbers in docs/perf.md instead of relying on
 * impressions.
 *
 * Budgets are CI tripwires against accidental quadratic blowups, not
 * microbenchmark assertions - the logged numbers are the record. They stay
 * in the default unit gate because the broad limit catches order-of-magnitude
 * regressions while tolerating shared-host contention. The test timeout must
 * exceed that limit so the budget assertion remains the source of failure.
 */
import { describe, expect, it } from 'vitest'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import type { WorkflowDocument } from '../src/format/document.js'
import { loadDocument } from '../src/format/migrate.js'
import { syntheticWorkflow } from '../src/format/synthetic.js'

const CHAINS = 60
const CHAIN_LENGTH = 20
const NODES = CHAINS * CHAIN_LENGTH
const PERFORMANCE_BUDGET_MS = 10_000
const TEST_TIMEOUT_MS = 15_000

function freshStore(): { store: DocumentStore; doc: WorkflowDocument } {
  const json = syntheticWorkflow({ chains: CHAINS, chainLength: CHAIN_LENGTH })
  const doc = loadDocument(json).document!
  return { store: new DocumentStore(doc, coreCommandRegistry()), doc }
}

function log(label: string, ms: number, ops: number): void {
  // eslint-disable-next-line no-console
  console.log(`[perf-dispatch] ${label}: ${ms.toFixed(1)}ms total, ${((ms / ops) * 1000).toFixed(1)}us/op (${ops} ops)`)
}

describe(`dispatch throughput on the synthetic workload (${NODES} nodes)`, { timeout: TEST_TIMEOUT_MS }, () => {
  it('node.setValue churn: 1000 dispatches', () => {
    const { store } = freshStore()
    const t0 = performance.now()
    for (let i = 0; i < 1000; i++) {
      const out = store.dispatch({
        command: 'node.setValue',
        params: { graphId: 'g0', nodeId: 'n0', inputId: 'width', value: 64 + (i % 512) },
      })
      if (!out.ok) throw new Error(JSON.stringify(out.diagnostics))
    }
    const ms = performance.now() - t0
    log('node.setValue x1000', ms, 1000)
    expect(ms, `setValue churn took ${ms.toFixed(1)}ms`).toBeLessThan(PERFORMANCE_BUDGET_MS)
  })

  it('node.add: 300 dispatches', () => {
    const { store } = freshStore()
    const t0 = performance.now()
    for (let i = 0; i < 300; i++) {
      const out = store.dispatch({
        command: 'node.add',
        params: { graphId: 'g0', type: 'EmptyImage', position: { x: i * 10, y: 0 }, values: { width: 64, height: 64 } },
      })
      if (!out.ok) throw new Error(JSON.stringify(out.diagnostics))
    }
    const ms = performance.now() - t0
    log('node.add x300', ms, 300)
    expect(ms, `bulk add took ${ms.toFixed(1)}ms`).toBeLessThan(PERFORMANCE_BUDGET_MS)
  })

  it('bulk delete: one graph.deleteItems over 10 whole chains (200 nodes)', () => {
    const { store, doc } = freshStore()
    // Drop the first 10 chains: their links cascade with the nodes.
    const nodeIds = Object.keys(doc.graphs['g0']!.nodes).slice(0, 10 * CHAIN_LENGTH)
    const t0 = performance.now()
    const out = store.dispatch({ command: 'graph.deleteItems', params: { graphId: 'g0', nodeIds } })
    const ms = performance.now() - t0
    if (!out.ok) throw new Error(JSON.stringify(out.diagnostics))
    log('graph.deleteItems 200 nodes', ms, nodeIds.length)
    expect(ms, `bulk delete took ${ms.toFixed(1)}ms`).toBeLessThan(PERFORMANCE_BUDGET_MS)
  })

  it('undo/redo replay: 200 each after setValue churn', () => {
    const { store } = freshStore()
    for (let i = 0; i < 200; i++) {
      store.dispatch({
        command: 'node.setValue',
        params: { graphId: 'g0', nodeId: 'n0', inputId: 'width', value: 100 + i },
      })
    }
    let t0 = performance.now()
    for (let i = 0; i < 200; i++) if (!store.undo()) throw new Error('undo exhausted')
    const undoMs = performance.now() - t0
    log('undo x200', undoMs, 200)

    t0 = performance.now()
    for (let i = 0; i < 200; i++) if (!store.redo()) throw new Error('redo exhausted')
    const redoMs = performance.now() - t0
    log('redo x200', redoMs, 200)

    expect(undoMs, `undo took ${undoMs.toFixed(1)}ms`).toBeLessThan(PERFORMANCE_BUDGET_MS)
    expect(redoMs, `redo took ${redoMs.toFixed(1)}ms`).toBeLessThan(PERFORMANCE_BUDGET_MS)
  })
})
