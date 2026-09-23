/**
 * Live integration: the full live loop against a real ComfyUI server.
 * Skipped unless DINKSTER_LIVE_URL is set (e.g. http://127.0.0.1:8199).
 *
 *   DINKSTER_LIVE_URL=http://127.0.0.1:8199 pnpm --filter @dinkster/client test
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  asConnectionId,
  compile,
  loadDocument,
  type WorkflowDocument,
} from '@dinkster/core'
import { ExecutionStore, type WebSocketLike } from '../src/index.js'
import { BackendConnection } from '../src/comfy-v1.js'

const LIVE_URL = process.env['DINKSTER_LIVE_URL']
const coreRoot = join(dirname(fileURLToPath(import.meta.url)), '../../core')
const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(coreRoot, rel), 'utf8'))

describe.skipIf(!LIVE_URL)('live server loop', () => {
  it.each(['exec-basic', 'exec-subgraph'] as const)(
    '%s: schemas -> compile -> submit -> completed',
    async (name) => {
      const conn = new BackendConnection({
        id: asConnectionId('live'),
        baseUrl: LIVE_URL!,
        clientId: `dinkster-live-${Date.now()}`,
        // Node 22+ global WebSocket.
        webSocketFactory: (url) => new WebSocket(url) as unknown as WebSocketLike,
      })
      const store = new ExecutionStore()
      conn.onEvent((e) => store.apply(e))

      const registry = await conn.fetchSchemas()
      expect(registry.schemas.size).toBeGreaterThan(100)

      const doc = loadDocument(readJson(`fixtures/workflows/${name}.json`)).document as WorkflowDocument
      const compiled = compile({
        document: doc,
        revision: 1,
        resolve: registry.resolve,
        scope: { kind: 'full' },
        connection: conn.id,
        schemaHash: registry.hash,
      })
      expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
      if (!compiled.ok) return

      conn.connect()
      await waitFor(() => conn.status.get() === 'connected', 5000, 'ws connect')

      const submitted = await conn.submit(compiled.artifact)
      expect(submitted.ok, JSON.stringify(!submitted.ok && submitted.diagnostics)).toBe(true)
      if (!submitted.ok) return
      store.register(submitted.execution, compiled.artifact)

      await waitFor(() => {
        const s = store.get(submitted.execution)
        return s !== undefined && s.status !== 'queued' && s.status !== 'running'
      }, 30000, 'execution terminal')

      const state = store.get(submitted.execution)!
      expect(state.status, JSON.stringify(state.errors)).toBe('completed')
      // Every prompt node reached a terminal per-node state.
      for (const runtimeId of Object.keys(compiled.artifact.prompt)) {
        expect(['done', 'cached']).toContain(state.nodes[runtimeId]?.state)
      }
      conn.disconnect()
    },
    60000,
  )
})

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}
