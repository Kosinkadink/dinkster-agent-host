import { describe, expect, it } from 'vitest'
import {
  HOST_UI_MAX_CHILDREN,
  HOST_UI_MAX_DEPTH,
  HOST_UI_MAX_ID_LENGTH,
  HOST_UI_MAX_NODES,
  HOST_UI_MAX_PAYLOAD_JSON_BYTES,
  HOST_UI_MAX_VISIBLE_STRING_LENGTH,
  createHostUiProviderContextV1,
  decodeHostUiContributionV1,
  type HostUiProviderV1,
} from '../src/index.js'

const contribution = (root: unknown): unknown => ({ version: 1, root })
const text = (key = 'text'): unknown => ({ kind: 'text', key, text: 'hello' })
const codes = (value: unknown): string[] => decodeHostUiContributionV1(value).diagnostics.map((item) => item.message)

describe('HostUiContributionV1 decoding', () => {
  it('accepts every node kind and returns a recursively frozen host-owned copy', () => {
    const input = contribution({ kind: 'group', key: 'root', direction: 'row', children: [
      { kind: 'text', key: 'text', text: 'Text', tone: 'neutral' },
      { kind: 'status', key: 'status', text: 'Ready', tone: 'success', live: 'polite' },
      { kind: 'action', key: 'action', label: 'Run', command: 'demo.run', payload: { count: 2 }, tone: 'accent', disabled: false, disabledReason: 'Not now' },
    ] }) as { root: { children: Array<{ text?: string }> } }
    const decoded = decodeHostUiContributionV1(input)
    expect(decoded.diagnostics).toEqual([])
    expect(decoded.contribution).toEqual(input)
    expect(decoded.contribution).not.toBe(input)
    expect(Object.isFrozen(decoded.contribution)).toBe(true)
    expect(Object.isFrozen(decoded.contribution!.root)).toBe(true)
    expect(Object.isFrozen((decoded.contribution!.root as { children: readonly unknown[] }).children)).toBe(true)
    input.root.children[0]!.text = 'changed'
    expect((decoded.contribution!.root as { children: readonly { text?: string }[] }).children[0]!.text).toBe('Text')
  })

  it('owns the bounded asset editor presentation without assigning field or origin semantics', () => {
    const input = contribution({
      kind: 'asset-editor',
      key: 'asset.editor',
      presentation: {
        heading: 'Portrait study',
        description: 'Supplied presentation state',
        viewport: { label: 'Image preview', state: 'ready', detail: '2048 x 2048' },
        fields: [
          {
            key: 'field.prompt',
            kind: 'display',
            label: 'Prompt',
            value: 'A portrait',
            origin: { label: 'UI-authored', detail: 'Displayed origin only', tone: 'accent' },
            capability: { kind: 'editable', label: 'Editable' },
            validation: { key: 'field.prompt.validation', tone: 'warning', text: 'Review this value.' },
            action: { key: 'field.prompt.action', label: 'Edit', command: 'demo.edit-prompt', state: 'enabled' },
          },
          {
            key: 'field.future',
            kind: 'future-control',
            label: 'Future field',
            value: '',
            capability: { kind: 'future-capability' },
          },
        ],
        messages: [{ key: 'notice.version', tone: 'info', text: 'Version supplied upstream.' }],
        factGroups: [{
          key: 'facts.source',
          label: 'Source',
          facts: [
            { key: 'fact.source', label: 'Input', state: 'ready', value: 'source.png' },
            { key: 'fact.pending', label: 'Metadata', state: 'pending', detail: 'Reading supplied facts' },
          ],
        }],
        tools: [{
          key: 'tool.timeline',
          label: 'Timeline',
          state: 'loading',
          detail: 'Loading supplied tool state',
          actions: [{ key: 'tool.timeline.cancel', label: 'Cancel', command: 'demo.cancel-tool', state: 'enabled' }],
        }],
        actions: [{
          key: 'action.export',
          label: 'Export',
          command: 'demo.export',
          state: 'pending',
          detail: 'Exporting',
        }],
      },
    })
    const decoded = decodeHostUiContributionV1(input)
    expect(decoded.diagnostics).toEqual([])
    expect(decoded.contribution).toEqual(input)
    const root = decoded.contribution!.root as { presentation: { fields: readonly { kind: string; value: string; capability: { kind: string } }[] } }
    expect(root.presentation.fields[1]).toEqual(expect.objectContaining({ kind: 'future-control', capability: { kind: 'future-capability' } }))
    expect(Object.isFrozen(root.presentation)).toBe(true)
    expect(Object.isFrozen(root.presentation.fields)).toBe(true)
    expect(Object.isFrozen(root.presentation.fields[0])).toBe(true)
    expect(root.presentation.fields[1]?.value).toBe('')
  })

  it('keeps the asset editor root-only and rejects unbounded presentation properties', () => {
    const presentation = {
      heading: 'Asset',
      viewport: { label: 'Preview', state: 'absent' },
      fields: [],
    }
    expect(codes(contribution({
      kind: 'group',
      key: 'root',
      direction: 'column',
      children: [{ kind: 'asset-editor', key: 'nested', presentation }],
    })).join('\n')).toContain('must be the root')
    expect(codes(contribution({
      kind: 'asset-editor',
      key: 'asset.editor',
      presentation: { ...presentation, route: '/api/assets' },
    })).join('\n')).toContain('route')
    expect(codes(contribution({
      kind: 'asset-editor',
      key: 'asset.editor',
      presentation: {
        ...presentation,
        actions: [{
          key: 'action.apply',
          label: 'Apply',
          command: 'demo.apply',
          state: 'pending',
          cancel: { label: 'Cancel', command: 'demo.cancel' },
        }],
      },
    })).join('\n')).toContain('cancel')
    expect(codes(contribution({
      kind: 'asset-editor',
      key: 'asset.editor',
      presentation: {
        ...presentation,
        fields: [
          { key: 'field.same', kind: 'display', label: 'First', value: '', capability: { kind: 'read-only' } },
          { key: 'field.same', kind: 'display', label: 'Second', value: '', capability: { kind: 'read-only' } },
        ],
      },
    })).join('\n')).toContain('$.root.presentation.fields[1].key')
  })

  it.each([
    ['function', () => contribution({ kind: 'action', key: 'a', label: 'A', command: 'a.run', payload: { bad: () => {} } })],
    ['symbol', () => contribution({ kind: 'action', key: 'a', label: 'A', command: 'a.run', payload: Symbol('bad') })],
    ['symbol key', () => {
      const node = { kind: 'text', key: 'a', text: 'A', [Symbol('bad')]: true }
      return contribution(node)
    }],
    ['bigint', () => contribution({ kind: 'action', key: 'a', label: 'A', command: 'a.run', payload: 1n })],
    ['undefined', () => contribution({ kind: 'action', key: 'a', label: 'A', command: 'a.run', payload: undefined })],
    ['date', () => contribution({ kind: 'action', key: 'a', label: 'A', command: 'a.run', payload: new Date() })],
    ['class instance', () => contribution(new (class Node { kind = 'text'; key = 'a'; text = 'A' })())],
    ['NaN', () => contribution({ kind: 'action', key: 'a', label: 'A', command: 'a.run', payload: Number.NaN })],
    ['infinity', () => contribution({ kind: 'action', key: 'a', label: 'A', command: 'a.run', payload: Infinity })],
  ])('rejects forbidden %s values', (_name, make) => {
    expect(decodeHostUiContributionV1(make()).contribution).toBeUndefined()
  })

  it('rejects unknown keys, duplicate node keys, and malformed commands with paths', () => {
    expect(codes({ version: 1, extra: true, root: text() }).join('\n')).toContain('$["extra"]')
    expect(codes(contribution({ kind: 'group', key: 'root', direction: 'row', children: [text('same'), text('same')] })).join('\n')).toContain('$.root.children[1].key')
    expect(codes(contribution({ kind: 'action', key: 'a', label: 'A', command: 'not-dotted' })).join('\n')).toContain('$.root.command')
  })

  it('rejects cycles and shared aliases', () => {
    const cyclic: Record<string, unknown> = { kind: 'group', key: 'root', direction: 'row', children: [] }
    ;(cyclic.children as unknown[]).push(cyclic)
    expect(codes(contribution(cyclic)).join('\n')).toContain('cycle or shared')
    const shared = text('shared')
    expect(codes(contribution({ kind: 'group', key: 'root', direction: 'row', children: [shared, shared] })).join('\n')).toContain('cycle or shared')
  })

  it('rejects accessor and decorated arrays without invoking them', () => {
    const accessor: unknown[] = []
    Object.defineProperty(accessor, '0', { enumerable: true, get: () => { throw new Error('must not run') } })
    Object.defineProperty(accessor, 'length', { value: 1 })
    expect(() => decodeHostUiContributionV1(contribution({ kind: 'action', key: 'a', label: 'A', command: 'a.run', payload: accessor }))).not.toThrow()
    expect(decodeHostUiContributionV1(contribution({ kind: 'action', key: 'a', label: 'A', command: 'a.run', payload: accessor })).contribution).toBeUndefined()
    const decorated: unknown[] = []
    Object.defineProperty(decorated, Symbol('bad'), { value: true })
    expect(decodeHostUiContributionV1(contribution({ kind: 'action', key: 'a', label: 'A', command: 'a.run', payload: decorated })).contribution).toBeUndefined()
  })

  it('contains hostile proxy inspection failures', () => {
    const hostile = new Proxy({}, { getPrototypeOf: () => { throw new Error('attacker detail') } })
    const decoded = decodeHostUiContributionV1(hostile)
    expect(decoded.contribution).toBeUndefined()
    expect(decoded.diagnostics).toHaveLength(1)
    expect(decoded.diagnostics[0]?.code).toBe('host-ui.invalid')
    expect(decoded.diagnostics[0]?.message).not.toContain('attacker detail')
  })

  it.each([
    ['root', () => new Proxy(contribution(text()) as object, {})],
    ['nested object', () => contribution(new Proxy(text() as object, {}))],
    ['nested array', () => contribution({ kind: 'group', key: 'root', direction: 'row', children: new Proxy([text()], {}) })],
  ])('rejects a transparent proxy at the contribution %s boundary', (_name, make) => {
    const decoded = decodeHostUiContributionV1(make())
    expect(decoded.contribution).toBeUndefined()
    expect(decoded.diagnostics).toHaveLength(1)
    expect(decoded.diagnostics[0]?.code).toBe('host-ui.invalid')
  })

  it('owns prototype-named JSON keys and bounds diagnostics', () => {
    const payload = JSON.parse('{"__proto__":{"mutable":true}}') as unknown
    const decoded = decodeHostUiContributionV1(contribution({ kind: 'action', key: 'a', label: 'A', command: 'a.run', payload }))
    const owned = (decoded.contribution!.root as { payload: Record<string, unknown> }).payload
    expect(Object.hasOwn(owned, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(owned)).toBeNull()
    expect(Object.isFrozen(owned['__proto__'])).toBe(true)

    const root: Record<string, unknown> = { kind: 'text', key: 'a', text: 'A' }
    for (let index = 0; index < 100; index += 1) root[`${'x'.repeat(1000)}-${index}`] = true
    const diagnostics = decodeHostUiContributionV1(contribution(root)).diagnostics
    expect(diagnostics.length).toBeLessThanOrEqual(32)
    expect(Math.max(...diagnostics.map((item) => item.message.length))).toBeLessThan(200)
  })

  it('enforces every exported limit', () => {
    expect(codes(contribution({ kind: 'group', key: 'root', direction: 'row', children: Array.from({ length: HOST_UI_MAX_CHILDREN + 1 }, (_, index) => text(`n-${index}`)) })).join('\n')).toContain('child limit')
    let deep: unknown = text('leaf')
    for (let index = 0; index < HOST_UI_MAX_DEPTH; index += 1) deep = { kind: 'group', key: `g-${index}`, direction: 'column', children: [deep] }
    expect(codes(contribution(deep)).join('\n')).toContain('depth limit')
    const branches = Array.from({ length: 5 }, (_, branch) => ({ kind: 'group', key: `branch-${branch}`, direction: 'row', children: Array.from({ length: 32 }, (_, index) => text(`n-${branch}-${index}`)) }))
    expect(codes(contribution({ kind: 'group', key: 'root', direction: 'row', children: branches })).join('\n')).toContain(`${HOST_UI_MAX_NODES} node`)
    const factGroups = Array.from({ length: 4 }, (_, group) => ({
      key: `facts-${group}`,
      label: `Facts ${group}`,
      facts: Array.from({ length: HOST_UI_MAX_CHILDREN }, (_, fact) => ({
        key: `fact-${group}-${fact}`,
        label: `Fact ${fact}`,
        state: 'ready',
      })),
    }))
    expect(codes(contribution({
      kind: 'asset-editor',
      key: 'asset.editor',
      presentation: { heading: 'Asset', viewport: { label: 'Preview', state: 'ready' }, fields: [], factGroups },
    })).join('\n')).toContain('presentation value limit')
    expect(codes(contribution({ kind: 'text', key: 'a', text: 'x'.repeat(HOST_UI_MAX_VISIBLE_STRING_LENGTH + 1) })).join('\n')).toContain('character limit')
    expect(codes(contribution({ kind: 'text', key: 'x'.repeat(HOST_UI_MAX_ID_LENGTH + 1), text: 'x' })).join('\n')).toContain('character limit')
    expect(codes(contribution({ kind: 'action', key: 'a', label: 'A', command: 'a.run', payload: 'x'.repeat(HOST_UI_MAX_PAYLOAD_JSON_BYTES) })).join('\n')).toContain('byte JSON limit')
    expect(codes(contribution({ kind: 'action', key: 'a', label: 'A', command: 'a.run', payload: Array.from({ length: HOST_UI_MAX_NODES }, () => null) })).join('\n')).toContain('value limit')
  })

  it('rejects oversized payload strings and keys during JSON preflight', () => {
    const oversized = 'x'.repeat(HOST_UI_MAX_PAYLOAD_JSON_BYTES + 1)
    const stringMessages = codes(contribution({ kind: 'action', key: 'a', label: 'A', command: 'a.run', payload: oversized }))
    expect(stringMessages.join('\n')).toContain('JSON preflight limit')
    expect(Math.max(...stringMessages.map((message) => message.length))).toBeLessThan(200)
    const keyMessages = codes(contribution({ kind: 'action', key: 'a', label: 'A', command: 'a.run', payload: { [oversized]: null } }))
    expect(keyMessages.join('\n')).toContain('JSON key preflight limit')
    expect(Math.max(...keyMessages.map((message) => message.length))).toBeLessThan(200)
  })
})

describe('HostUiProviderContextV1', () => {
  it('clones and recursively freezes JSON before provider invocation', () => {
    const data = { nested: { value: 'host' } }
    const context = createHostUiProviderContextV1('status', data)
    const provider: HostUiProviderV1 = (received) => {
      expect(Object.isFrozen(received)).toBe(true)
      expect(Object.isFrozen(received.data)).toBe(true)
      expect(() => { (received.data as { nested: { value: string } }).nested.value = 'extension' }).toThrow()
      return contribution(text())
    }
    provider(context)
    data.nested.value = 'changed'
    expect((context.data as { nested: { value: string } }).nested.value).toBe('host')
  })

  it('preserves and freezes prototype-named context keys as owned data', () => {
    const context = createHostUiProviderContextV1('status', JSON.parse('{"__proto__":{"value":1}}'))
    expect(Object.hasOwn(context.data as object, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(context.data)).toBeNull()
    expect(Object.isFrozen((context.data as Record<string, unknown>)['__proto__'])).toBe(true)
  })

  it('rejects oversized context strings and keys during JSON preflight', () => {
    const oversized = 'x'.repeat(HOST_UI_MAX_PAYLOAD_JSON_BYTES + 1)
    expect(() => createHostUiProviderContextV1('status', oversized)).toThrow(/JSON preflight limit/)
    expect(() => createHostUiProviderContextV1('status', { [oversized]: null })).toThrow(/JSON key preflight limit/)
  })

  it('contains hostile context proxy inspection failures', () => {
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error('attacker detail') } })
    expect(() => createHostUiProviderContextV1('status', hostile as never)).toThrow(new TypeError('$.data: could not be safely inspected'))
  })

  it.each([
    ['root', () => new Proxy({ value: 'host' }, {})],
    ['nested object', () => ({ nested: new Proxy({ value: 'host' }, {}) })],
    ['nested array', () => ({ nested: new Proxy(['host'], {}) })],
  ])('rejects a transparent proxy at the context %s boundary', (_name, make) => {
    expect(() => createHostUiProviderContextV1('status', make())).toThrow(new TypeError('$.data: could not be safely inspected'))
  })
})
