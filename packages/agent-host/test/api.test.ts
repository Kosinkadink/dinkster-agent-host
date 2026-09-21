import { coreCommandRegistry, createLocalSession } from '@dinkster/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentDocument, createAgentHandle } from '../src/api.js'

describe('agent session handle', () => {
  afterEach(() => vi.useRealTimers())

  it('dispatches commands and returns a detached JSON document', () => {
    const session = createLocalSession(createAgentDocument('api-test'), coreCommandRegistry())
    const handle = createAgentHandle(session)

    const result = handle.dispatch('node.add', {
      graphId: 'g0', type: 'TestNode', position: { x: 10, y: 20 }, values: { seed: 4 },
    })
    const document = handle.getDocument()

    expect(result.ok).toBe(true)
    expect(result.diagnostics).toEqual([])
    expect(Object.values(document.graphs.g0!.nodes)[0]).toMatchObject({
      type: 'TestNode', values: { seed: 4 },
    })
    expect(document).not.toBe(session.doc)
  })

  it('returns command refusal diagnostics instead of throwing', () => {
    const session = createLocalSession(createAgentDocument('api-test'), coreCommandRegistry())
    const result = createAgentHandle(session).dispatch('node.remove', {
      graphId: 'g0', nodeIds: ['missing'],
    })

    expect(result.ok).toBe(false)
    expect(result.diagnostics[0]?.code).toBe('node.missing')
  })

  it('announces agent identity until the handle closes', () => {
    vi.useFakeTimers()
    const sendPresence = vi.fn()
    const close = vi.fn()
    const session = Object.assign(
      createLocalSession(createAgentDocument('presence-test'), coreCommandRegistry()),
      { sendPresence },
    )
    const handle = createAgentHandle(session, undefined, close, {
      displayName: 'workflow agent', owner: 'alice', harness: 'test-harness',
    })

    expect(sendPresence).toHaveBeenCalledWith({
      v: 1,
      graph: 'g0',
      cursor: null,
      selection: [],
      activity: { v: 1, type: 'agent_tool_call', tool: 'connect', status: 'success', pendingAsks: [] },
      identity: {
        kind: 'agent',
        displayName: 'workflow agent',
        owner: 'alice',
        harness: 'test-harness',
      },
    })

    vi.advanceTimersByTime(4000)
    expect(sendPresence).toHaveBeenCalledTimes(3)
    expect(sendPresence.mock.calls[1]?.[0]).toBe(sendPresence.mock.calls[0]?.[0])

    handle.close()
    vi.advanceTimersByTime(4000)
    expect(sendPresence).toHaveBeenCalledTimes(4)
    expect(sendPresence).toHaveBeenLastCalledWith({ v: 1, gone: true })
    expect(close).toHaveBeenCalledOnce()
  })

  it('publishes and withdraws setting proposals immediately', () => {
    const sendPresence = vi.fn()
    const session = Object.assign(
      createLocalSession(createAgentDocument('proposal-test'), coreCommandRegistry()),
      { sendPresence },
    )
    const handle = createAgentHandle(session, undefined, undefined, { displayName: 'settings agent' })

    const id = handle.proposeSetting({ settingId: 'canvas.grid.visible', value: false, note: 'Reduce clutter' })
    expect(id).toMatch(/^proposal-/)
    expect(sendPresence).toHaveBeenLastCalledWith(expect.objectContaining({
      proposals: [{ id, settingId: 'canvas.grid.visible', value: false, note: 'Reduce clutter' }],
    }))

    handle.withdrawProposal(id)
    expect(sendPresence.mock.calls.at(-1)?.[0]).not.toHaveProperty('proposals')
    handle.close()
    expect(sendPresence).toHaveBeenLastCalledWith({ v: 1, gone: true })
  })

  it('enforces proposal caps before publishing', () => {
    const session = Object.assign(
      createLocalSession(createAgentDocument('proposal-caps'), coreCommandRegistry()),
      { sendPresence: vi.fn() },
    )
    const handle = createAgentHandle(session, undefined, undefined, {})
    for (let index = 0; index < 8; index += 1) {
      handle.proposeSetting({ settingId: `test.setting-${index}`, value: index })
    }
    expect(() => handle.proposeSetting({ settingId: 'test.setting-over', value: true })).toThrow('limit of 8')
    handle.withdrawProposal('missing')
    handle.close()
  })
})
