import type { Json } from '@dinkster/core'
import { describe, expect, it } from 'vitest'
import {
  decodePresence,
  encodePresence,
  PRESENCE_MAX_PROPOSALS,
  PRESENCE_MAX_PROPOSAL_ID,
  PRESENCE_MAX_PROPOSAL_NOTE,
  PRESENCE_MAX_PROPOSAL_SETTING_ID,
  PRESENCE_MAX_PROPOSAL_VALUE,
} from '../src/presence-payload.js'

const frame = (proposals?: Json): Json => ({
  v: 1,
  graph: 'g0',
  cursor: null,
  selection: [],
  ...(proposals !== undefined ? { proposals } : {}),
})

const proposal = (over: Record<string, Json> = {}): Json => ({
  id: 'proposal-1',
  settingId: 'canvas.grid.visible',
  value: false,
  note: 'Use a cleaner canvas',
  ...over,
})

describe('settings proposals in presence', () => {
  it('round-trips proposals while frames without them remain unchanged', () => {
    const without = encodePresence({ graph: 'g0', cursor: undefined, selection: [] })
    expect(without).not.toHaveProperty('proposals')
    expect(decodePresence(without)).not.toHaveProperty('proposals')

    const encoded = encodePresence({
      graph: 'g0', cursor: undefined, selection: [],
      proposals: [{ id: 'proposal-1', settingId: 'canvas.grid.visible', value: false, note: 'Use a cleaner canvas' }],
    })
    expect(decodePresence(encoded)).toMatchObject({
      proposals: [{ id: 'proposal-1', settingId: 'canvas.grid.visible', value: false, note: 'Use a cleaner canvas' }],
    })
  })

  it.each<[string, Json]>([
    ['non-array field', frame('proposal')],
    ['empty array', frame([])],
    ['too many entries', frame(Array.from({ length: PRESENCE_MAX_PROPOSALS + 1 }, (_, i) => proposal({ id: `p-${i}` })))],
    ['non-object entry', frame(['proposal'])],
    ['missing id', frame([{ settingId: 'canvas.grid.visible', value: false }])],
    ['wrong id type', frame([proposal({ id: 7 })])],
    ['empty id', frame([proposal({ id: '' })])],
    ['long id', frame([proposal({ id: 'x'.repeat(PRESENCE_MAX_PROPOSAL_ID + 1) })])],
    ['duplicate ids', frame([proposal(), proposal({ settingId: 'canvas.snap.visible' })])],
    ['missing setting id', frame([{ id: 'p-1', value: false }])],
    ['wrong setting id type', frame([proposal({ settingId: 7 })])],
    ['empty setting id', frame([proposal({ settingId: '' })])],
    ['long setting id', frame([proposal({ settingId: 'x'.repeat(PRESENCE_MAX_PROPOSAL_SETTING_ID + 1) })])],
    ['missing value', frame([{ id: 'p-1', settingId: 'canvas.grid.visible' }])],
    ['oversized value', frame([proposal({ value: 'x'.repeat(PRESENCE_MAX_PROPOSAL_VALUE + 1) })])],
    ['wrong note type', frame([proposal({ note: 7 })])],
    ['long note', frame([proposal({ note: 'x'.repeat(PRESENCE_MAX_PROPOSAL_NOTE + 1) })])],
  ])('rejects %s', (_name, payload) => {
    expect(decodePresence(payload)).toBeNull()
  })

  it('drops invalid, duplicate, and over-cap entries while encoding', () => {
    const proposals = [
      { id: '', settingId: 'test.setting', value: true },
      ...Array.from({ length: PRESENCE_MAX_PROPOSALS + 2 }, (_, i) => ({ id: `p-${i}`, settingId: 'test.setting', value: i })),
      { id: 'p-0', settingId: 'test.setting', value: false },
    ]
    expect((encodePresence({ graph: 'g0', cursor: undefined, selection: [], proposals }) as { proposals: Json[] }).proposals)
      .toHaveLength(PRESENCE_MAX_PROPOSALS)
  })
})
