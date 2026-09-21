import { closeCollabSession } from '@dinkster/client'
import {
  asGraphDefId,
  asLineageId,
  asLinkId,
  asNodeId,
  type WorkflowDocument,
} from '@dinkster/core'
import { afterAll, describe, expect, it } from 'vitest'
import { connect, createSession } from '../src/api.js'

const LIVE_URL = process.env['DINKSTER_AGENT_LIVE_URL']

const document = (
  name: string,
  nodes: WorkflowDocument['graphs'][string]['nodes'],
  links: WorkflowDocument['graphs'][string]['links'],
): WorkflowDocument => ({
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: asLineageId(name),
  root: asGraphDefId('g0'),
  graphs: {
    g0: {
      id: asGraphDefId('g0'),
      name,
      nodes,
      links,
      nets: {},
      reroutes: {},
      nextOrdinal: 10,
    },
  },
  view: { graphs: {} },
})

const completedDocument = (name: string): WorkflowDocument => document(name, {
  source: { id: asNodeId('source'), type: 'dinkster.int', values: { value: 7 } },
  output: { id: asNodeId('output'), type: 'dinkster.preview_any', values: {} },
}, {
  l1: {
    id: asLinkId('l1'),
    from: { node: asNodeId('source'), port: 'value' as never },
    to: { node: asNodeId('output'), port: 'source' as never },
  },
})

const cancellableDocument = (name: string): WorkflowDocument => document(name, {
  source: { id: asNodeId('source'), type: 'dinkster.string', values: { value: 'slow value' } },
  delay: { id: asNodeId('delay'), type: 'dev.util.delay', values: { seconds: 10 } },
  output: { id: asNodeId('output'), type: 'dinkster.preview_any', values: {} },
}, {
  l1: {
    id: asLinkId('l1'),
    from: { node: asNodeId('source'), port: 'value' as never },
    to: { node: asNodeId('delay'), port: 'value' as never },
  },
  l2: {
    id: asLinkId('l2'),
    from: { node: asNodeId('delay'), port: 'value' as never },
    to: { node: asNodeId('output'), port: 'source' as never },
  },
})

describe.skipIf(!LIVE_URL)('agent execution tools against a native auth-off server', () => {
  const baseUrl = LIVE_URL!
  const sessionIds: string[] = []
  afterAll(async () => {
    for (const sessionId of sessionIds) await closeCollabSession(baseUrl, sessionId)
  })

  it('compiles, submits, follows and replays events, and reads the final value', async () => {
    const name = `agent-complete-${Date.now()}`
    const created = await createSession(baseUrl, { documentId: name, snapshot: completedDocument(name) })
    sessionIds.push(created.sessionId)
    const handle = await connect(baseUrl, created.sessionId, { actorId: `${name}-actor` })
    try {
      const compiled = await handle.compile()
      expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
      const submitted = await handle.submit()
      expect(submitted.ok, JSON.stringify(!submitted.ok && submitted.diagnostics)).toBe(true)
      if (!submitted.ok) return
      const jobId = submitted.execution.prompt
      let cursor = 0
      let terminal = false
      const received: string[] = []
      for (let attempt = 0; attempt < 30 && !terminal; attempt += 1) {
        const page = await handle.events({ jobId, after: cursor, waitMs: 1_000 })
        cursor = page.nextCursor
        received.push(...page.events.map(({ event }) => event.kind))
        terminal = page.events.some(({ event }) => event.kind === 'completed' || event.kind === 'error')
      }
      expect(received).toContain('nodeStates')
      expect(received).toContain('completed')
      const inspection = await handle.inspect(jobId)
      expect(inspection.job).toMatchObject({ state: 'completed', clientId: `${name}-actor` })
      expect(inspection.state).toMatchObject({ status: 'completed', errors: [] })
      const outputs = await handle.outputs(jobId)
      expect(outputs['output']?.['text']).toMatchObject({ typeId: 'core.string' })
      const value = await handle.value({ jobId, nodeId: 'output', outputId: 'text' })
      expect(value).toMatchObject({ available: true, descriptor: { typeId: 'core.string', value: '7' } })
      await expect(handle.problems(jobId)).resolves.toEqual([])
    } finally {
      handle.close()
    }
  }, 60_000)

  it('cancels only the requested long-running job', async () => {
    const name = `agent-cancel-${Date.now()}`
    const created = await createSession(baseUrl, { documentId: name, snapshot: cancellableDocument(name) })
    sessionIds.push(created.sessionId)
    const handle = await connect(baseUrl, created.sessionId, { actorId: `${name}-actor` })
    try {
      const first = await handle.submit()
      const second = await handle.submit()
      expect(first.ok && second.ok).toBe(true)
      if (!first.ok || !second.ok) return
      await handle.cancel(first.execution.prompt)
      let firstState: string | undefined
      let secondState: string | undefined
      for (let attempt = 0; attempt < 30 && firstState !== 'cancelled'; attempt += 1) {
        const firstJobState = (await handle.inspect(first.execution.prompt)).job?.state
        const secondJobState = (await handle.inspect(second.execution.prompt)).job?.state
        firstState = typeof firstJobState === 'string' ? firstJobState : undefined
        secondState = typeof secondJobState === 'string' ? secondJobState : undefined
        if (firstState !== 'cancelled') await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(firstState).toBe('cancelled')
      expect(secondState).not.toBe('cancelled')
      await handle.cancel(second.execution.prompt)
    } finally {
      handle.close()
    }
  }, 60_000)
})
