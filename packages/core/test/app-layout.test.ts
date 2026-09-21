import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import type { GraphDef, Json, WorkflowDocument } from '../src/format/document.js'
import {
  APP_LAYOUT_EXT_KEY,
  appLayoutGrid,
  appLayoutGridOverlap,
  appLayout,
  automaticAppLayoutMobileOrder,
  localizeAppLayoutJson,
  removeAppLayoutGraphRefs,
  resolveAppLayoutGrid,
  type AppLayoutV1,
} from '../src/format/app-layout.js'
import { asGraphDefId, asLineageId, asNodeId } from '../src/ids.js'

const node = (id: string) => ({ id: asNodeId(id), type: 'LayoutNode', values: {} })

function graph(id: string): GraphDef {
  return {
    id: asGraphDefId(id),
    name: id,
    nodes: { n1: node('n1'), n2: node('n2') },
    links: {},
    nets: {},
    reroutes: {},
    nextOrdinal: 3,
  }
}

function doc(overrides: Partial<WorkflowDocument> = {}): WorkflowDocument {
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: asLineageId('app-layout'),
    root: asGraphDefId('g0'),
    graphs: { g0: graph('g0') },
    view: { graphs: { g0: { nodes: {} } } },
    ...overrides,
  }
}

const layoutJson = (items: Json[]): Json => ({
  version: 1,
  desktop: { items },
  mobile: { customized: false, items: [] },
})

const store = (value = doc()) => new DocumentStore(value, coreCommandRegistry())

const add = (target: DocumentStore, item: Json, parentId?: string, index?: number) => target.dispatch({
  command: 'app.layout.add',
  params: {
    item,
    ...(parentId === undefined ? {} : { parentId }),
    ...(index === undefined ? {} : { index }),
  },
})

const currentLayout = (target: DocumentStore): AppLayoutV1 => appLayout(target.doc)!

describe('App layout storage', () => {
  it('skips malformed and duplicate placements while ignoring future fields', () => {
    const value = layoutJson([
      { id: 'control', kind: 'control', ref: { graphId: 'g0', nodeId: 'n1', inputId: 'seed' }, x: 2, w: 4 },
      { id: 'bad-control', kind: 'control', ref: { graphId: 'g0', nodeId: 'n1' } },
      { id: 'control', kind: 'text', role: 'body', text: 'duplicate id' },
      { id: 'text', kind: 'text', role: 'heading', text: '**Safe** heading', future: { value: true } },
      { id: 'queue', kind: 'queue', label: 'Generate base', targets: [
        { graphId: 'g0', nodeId: 'n1', future: true },
        { graphId: 'g0', nodeId: 'n1' },
        { graphId: 'g0' },
      ], future: { value: true } },
      { id: 'bad-queue', kind: 'queue', label: 'Nothing', targets: [{ nodeId: 'n1' }] },
      { id: 'group', kind: 'group', title: 'Inputs', children: ['control', '', 'control', 3] },
      { id: 'unknown', kind: 'image', src: 'https://example.test/image.png' },
    ])
    expect(appLayout(doc({ ext: { [APP_LAYOUT_EXT_KEY]: value } }))).toEqual({
      version: 1,
      desktop: { items: [
        { id: 'control', kind: 'control', ref: { graphId: 'g0', nodeId: 'n1', inputId: 'seed' } },
        { id: 'text', kind: 'text', role: 'heading', text: '**Safe** heading' },
        { id: 'queue', kind: 'queue', label: 'Generate base', targets: [{ graphId: 'g0', nodeId: 'n1' }] },
        { id: 'group', kind: 'group', title: 'Inputs', children: ['control'] },
      ] },
      mobile: { customized: false, items: [] },
    })
  })

  it('treats malformed and unsupported containers as no layout', () => {
    expect(appLayout(doc())).toBeUndefined()
    expect(appLayout(doc({ ext: { [APP_LAYOUT_EXT_KEY]: [] } }))).toBeUndefined()
    expect(appLayout(doc({ ext: { [APP_LAYOUT_EXT_KEY]: { version: 2, desktop: { items: [] } } } }))).toBeUndefined()
    expect(appLayout(doc({ ext: { [APP_LAYOUT_EXT_KEY]: { version: 1, desktop: { items: null } } } }))).toBeUndefined()
  })

  it('reads legacy, customized, and malformed mobile containers tolerantly', () => {
    const items: Json[] = [
      { id: 'grid-right', kind: 'text', role: 'body', text: 'Right', x: 6, y: 0, w: 6, h: 1 },
      { id: 'flow', kind: 'text', role: 'body', text: 'Flow' },
      { id: 'grid-left', kind: 'text', role: 'body', text: 'Left', x: 0, y: 0, w: 6, h: 1 },
    ]
    const read = (mobile: Json | undefined) => appLayout(doc({ ext: { [APP_LAYOUT_EXT_KEY]: {
      version: 1,
      desktop: { items },
      ...(mobile === undefined ? {} : { mobile }),
    } } }))!.mobile

    expect(read({ customized: false, items: [] })).toEqual({ customized: false, items: [] })
    expect(read({ customized: true, items: [], order: ['flow', 7, 'missing', 'flow'] })).toEqual({
      customized: true,
      items: [],
      order: ['flow', 'grid-left', 'grid-right'],
    })
    for (const mobile of [
      undefined,
      null,
      [],
      { customized: 'yes', items: [] },
      { customized: true, items: ['legacy'], order: ['flow'] },
      { customized: true, order: ['flow'] },
      { customized: true, items: [], order: null },
    ] as const) {
      expect(read(mobile as Json | undefined)).toEqual({ customized: false, items: [] })
    }
  })

  it('derives mobile order from row-major grid placement before desktop flow order', () => {
    const items = appLayout(doc({ ext: { [APP_LAYOUT_EXT_KEY]: layoutJson([
      { id: 'flow-a', kind: 'text', role: 'body', text: 'Flow A' },
      { id: 'right', kind: 'text', role: 'body', text: 'Right', x: 6, y: 0, w: 6, h: 1 },
      { id: 'left', kind: 'text', role: 'body', text: 'Left', x: 0, y: 0, w: 6, h: 1 },
      { id: 'later', kind: 'text', role: 'body', text: 'Later', x: 0, y: 2, w: 12, h: 1 },
      { id: 'flow-b', kind: 'text', role: 'body', text: 'Flow B' },
    ]) } }))!.desktop.items
    expect(automaticAppLayoutMobileOrder(items)).toEqual(['left', 'right', 'later', 'flow-a', 'flow-b'])
  })

  it('retains complete grid rectangles and drops every invalid or partial coordinate set', () => {
    const value = layoutJson([
      { id: 'valid', kind: 'text', role: 'body', text: 'Valid', x: 2, y: 3, w: 4, h: 2 },
      { id: 'partial', kind: 'text', role: 'body', text: 'Partial', x: 0, y: 0, w: 6 },
      { id: 'negative', kind: 'text', role: 'body', text: 'Negative', x: -1, y: 0, w: 6, h: 1 },
      { id: 'fractional', kind: 'text', role: 'body', text: 'Fractional', x: 0, y: 0.5, w: 6, h: 1 },
      { id: 'wide', kind: 'text', role: 'body', text: 'Wide', x: 8, y: 0, w: 5, h: 1 },
      { id: 'huge', kind: 'text', role: 'body', text: 'Huge', x: 0, y: Number.MAX_VALUE, w: 6, h: 1 },
      { id: 'overflow', kind: 'text', role: 'body', text: 'Overflow', x: 0, y: Number.MAX_SAFE_INTEGER, w: 6, h: 1 },
    ])
    expect(appLayout(doc({ ext: { [APP_LAYOUT_EXT_KEY]: value } }))?.desktop.items).toEqual([
      { id: 'valid', kind: 'text', role: 'body', text: 'Valid', x: 2, y: 3, w: 4, h: 2 },
      { id: 'partial', kind: 'text', role: 'body', text: 'Partial' },
      { id: 'negative', kind: 'text', role: 'body', text: 'Negative' },
      { id: 'fractional', kind: 'text', role: 'body', text: 'Fractional' },
      { id: 'wide', kind: 'text', role: 'body', text: 'Wide' },
      { id: 'huge', kind: 'text', role: 'body', text: 'Huge' },
      { id: 'overflow', kind: 'text', role: 'body', text: 'Overflow' },
    ])
  })

  it('keeps group children flow-only and applies first-wins ids before resolving overlaps', () => {
    const value = layoutJson([
      { id: 'first', kind: 'text', role: 'body', text: 'First', x: 0, y: 0, w: 6, h: 2 },
      { id: 'first', kind: 'text', role: 'body', text: 'Duplicate', x: 6, y: 0, w: 6, h: 2 },
      { id: 'child', kind: 'text', role: 'body', text: 'Child', x: 6, y: 0, w: 6, h: 2 },
      { id: 'group', kind: 'group', title: 'Group', children: ['child'], x: 6, y: 0, w: 6, h: 2 },
    ])
    expect(appLayout(doc({ ext: { [APP_LAYOUT_EXT_KEY]: value } }))?.desktop.items).toEqual([
      { id: 'first', kind: 'text', role: 'body', text: 'First', x: 0, y: 0, w: 6, h: 2 },
      { id: 'child', kind: 'text', role: 'body', text: 'Child' },
      { id: 'group', kind: 'group', title: 'Group', children: ['child'], x: 6, y: 0, w: 6, h: 2 },
    ])
  })

  it('tolerates arbitrary shared-document coordinate values without returning an invalid grid', () => {
    const coordinate = fc.oneof(
      fc.integer({ min: -1_000_000, max: 1_000_000 }),
      fc.double({ noNaN: true, noDefaultInfinity: true }),
      fc.string(),
      fc.boolean(),
      fc.constant(null),
    )
    fc.assert(fc.property(coordinate, coordinate, coordinate, coordinate, (x, y, w, h) => {
      const parsed = appLayout(doc({ ext: { [APP_LAYOUT_EXT_KEY]: layoutJson([
        { id: 'fuzz', kind: 'text', role: 'body', text: 'Fuzz', x, y, w, h } as Json,
      ]) } }))!.desktop.items[0]!
      const grid = appLayoutGrid(parsed)
      if (grid === undefined) return
      expect(Number.isSafeInteger(grid.x)).toBe(true)
      expect(Number.isSafeInteger(grid.y)).toBe(true)
      expect(Number.isSafeInteger(grid.w)).toBe(true)
      expect(Number.isSafeInteger(grid.h)).toBe(true)
      expect(grid.x).toBeGreaterThanOrEqual(0)
      expect(grid.x + grid.w).toBeLessThanOrEqual(12)
      expect(grid.y).toBeGreaterThanOrEqual(0)
      expect(grid.h).toBeGreaterThanOrEqual(1)
    }), { numRuns: 500 })
  })

  it('localizes only the first valid occurrence of each placement id', () => {
    const value = layoutJson([
      { id: 'retained', kind: 'control', ref: { graphId: 'g0', nodeId: 'n1', inputId: 'seed' } },
      { id: 'retained', kind: 'control', ref: { graphId: 'source', nodeId: 'n1', inputId: 'seed' } },
      { id: 'copied', kind: 'preview', ref: { graphId: 'source', nodeId: 'n2' } },
      { id: 'copied', kind: 'preview', ref: { graphId: 'source', nodeId: 'duplicate' } },
      { id: 'queue', kind: 'queue', label: 'Run outputs', targets: [
        { graphId: 'source', nodeId: 'n1' },
        { graphId: 'g0', nodeId: 'n2' },
      ] },
      { id: 'group', kind: 'group', title: 'Results', children: ['retained', 'copied'] },
    ])

    expect(localizeAppLayoutJson(value, 'source', 'localized')).toEqual(layoutJson([
      { id: 'retained', kind: 'control', ref: { graphId: 'g0', nodeId: 'n1', inputId: 'seed' } },
      { id: 'retained', kind: 'control', ref: { graphId: 'source', nodeId: 'n1', inputId: 'seed' } },
      { id: 'copied', kind: 'preview', ref: { graphId: 'source', nodeId: 'n2' } },
      { id: 'copied@localized', kind: 'preview', ref: { graphId: 'localized', nodeId: 'n2' } },
      { id: 'copied', kind: 'preview', ref: { graphId: 'source', nodeId: 'duplicate' } },
      { id: 'queue', kind: 'queue', label: 'Run outputs', targets: [
        { graphId: 'source', nodeId: 'n1' },
        { graphId: 'g0', nodeId: 'n2' },
        { graphId: 'localized', nodeId: 'n1' },
      ] },
      { id: 'group', kind: 'group', title: 'Results', children: ['retained', 'copied', 'copied@localized'] },
    ]))
  })

  it('removes graph refs according to first-wins ids without resurrecting duplicates', () => {
    const value: Json = {
      version: 1,
      desktop: { items: [
        { id: 'retained', kind: 'control', ref: { graphId: 'g0', nodeId: 'n1', inputId: 'seed' } },
        { id: 'retained', kind: 'control', ref: { graphId: 'deleted', nodeId: 'n1', inputId: 'seed' } },
        { id: 'removed', kind: 'preview', ref: { graphId: 'deleted', nodeId: 'n2' } },
        { id: 'removed', kind: 'preview', ref: { graphId: 'g0', nodeId: 'n2' } },
        { id: 'removed', kind: 'control', ref: { graphId: 'g0' } },
        { id: 'trimmed-queue', kind: 'queue', label: 'Run both', targets: [
          { graphId: 'deleted', nodeId: 'n1' },
          { graphId: 'g0', nodeId: 'n2' },
        ] },
        { id: 'removed-queue', kind: 'queue', label: 'Run deleted', targets: [{ graphId: 'deleted', nodeId: 'n2' }] },
        { id: 'group', kind: 'group', title: 'Results', children: ['retained', 'removed'] },
      ] },
      mobile: { customized: true, items: [], order: ['group', 'removed', 'retained', 'future'] },
    }

    expect(removeAppLayoutGraphRefs(value, new Set(['deleted']))).toEqual({
      version: 1,
      desktop: { items: [
        { id: 'retained', kind: 'control', ref: { graphId: 'g0', nodeId: 'n1', inputId: 'seed' } },
        { id: 'retained', kind: 'control', ref: { graphId: 'deleted', nodeId: 'n1', inputId: 'seed' } },
        { id: 'trimmed-queue', kind: 'queue', label: 'Run both', targets: [{ graphId: 'g0', nodeId: 'n2' }] },
        { id: 'group', kind: 'group', title: 'Results', children: ['retained'] },
      ] },
      mobile: { customized: true, items: [], order: ['group', 'retained', 'future'] },
    })
  })
})

describe('App layout grid collision resolution', () => {
  it('keeps the edited placement fixed and pushes every collision down deterministically', () => {
    expect(resolveAppLayoutGrid([
      { id: 'a', x: 0, y: 0, w: 6, h: 2 },
      { id: 'b', x: 0, y: 1, w: 6, h: 2 },
      { id: 'c', x: 0, y: 2, w: 6, h: 1 },
    ], 'a')).toEqual([
      { id: 'a', x: 0, y: 0, w: 6, h: 2 },
      { id: 'b', x: 0, y: 2, w: 6, h: 2 },
      { id: 'c', x: 0, y: 4, w: 6, h: 1 },
    ])
  })

  it('compacts unaffected placements upward after resolving an overlap', () => {
    expect(resolveAppLayoutGrid([
      { id: 'target', x: 0, y: 2, w: 6, h: 2 },
      { id: 'pushed', x: 0, y: 2, w: 6, h: 1 },
      { id: 'gap', x: 6, y: 5, w: 6, h: 1 },
    ], 'target')).toEqual([
      { id: 'target', x: 0, y: 2, w: 6, h: 2 },
      { id: 'pushed', x: 0, y: 4, w: 6, h: 1 },
      { id: 'gap', x: 6, y: 0, w: 6, h: 1 },
    ])
  })

  it('returns an already valid layout unchanged and its resolved output is idempotent', () => {
    const valid = [
      { id: 'a', x: 0, y: 0, w: 6, h: 2 },
      { id: 'b', x: 6, y: 3, w: 6, h: 2 },
    ] as const
    expect(resolveAppLayoutGrid(valid)).toBe(valid)
    expect(resolveAppLayoutGrid(valid, 'a')).toBe(valid)

    const overlapping = [
      { id: 'a', x: 0, y: 0, w: 12, h: 1 },
      { id: 'b', x: 0, y: 0, w: 12, h: 1 },
    ] as const
    const resolved = resolveAppLayoutGrid(overlapping)!
    expect(resolved.some((item, index) => resolved.slice(index + 1).some((other) => appLayoutGridOverlap(item, other)))).toBe(false)
    expect(resolveAppLayoutGrid(resolved)).toBe(resolved)
  })

  it('settles dense valid coordinates without an arbitrary move limit', () => {
    const sizes = [
      [25, 26], [26, 2], [22, 1], [16, 5], [29, 1],
      [14, 20], [13, 10], [7, 29], [12, 26], [12, 29],
    ] as const
    const placements = sizes.map(([y, h], index) => ({ id: `dense-${index}`, x: 0, y, w: 12, h }))
    for (const priorityId of [undefined, 'dense-9']) {
      const resolved = resolveAppLayoutGrid(placements, priorityId)
      expect(resolved).toBeDefined()
      expect(resolved!.some((item, index) => resolved!.slice(index + 1)
        .some((other) => appLayoutGridOverlap(item, other)))).toBe(false)
      expect(resolveAppLayoutGrid(resolved!, priorityId)).toBe(resolved)
    }
  })

  it('rejects collision settlement beyond safe integer rows', () => {
    const y = Number.MAX_SAFE_INTEGER - 2
    expect(resolveAppLayoutGrid([
      { id: 'a', x: 0, y, w: 12, h: 1 },
      { id: 'b', x: 0, y, w: 12, h: 1 },
      { id: 'c', x: 0, y, w: 12, h: 1 },
    ], 'a')).toBeUndefined()
  })

  it('resolves arbitrary bounded overlaps without moving the priority placement', () => {
    const rectangle = fc.integer({ min: 0, max: 11 }).chain((x) => fc.record({
      x: fc.constant(x),
      y: fc.integer({ min: 0, max: 50 }),
      w: fc.integer({ min: 1, max: 12 - x }),
      h: fc.integer({ min: 1, max: 8 }),
    }))
    fc.assert(fc.property(fc.array(rectangle, { maxLength: 20 }), (rectangles) => {
      const placements = rectangles.map((grid, index) => ({ id: `item-${index}`, ...grid }))
      const priority = placements[0]
      const resolved = resolveAppLayoutGrid(placements, priority?.id)
      expect(resolved).toBeDefined()
      expect(resolved!.some((item, index) => resolved!.slice(index + 1)
        .some((other) => appLayoutGridOverlap(item, other)))).toBe(false)
      if (priority !== undefined) expect(resolved![0]).toEqual(priority)
      expect(resolveAppLayoutGrid(resolved!)).toBe(resolved)
    }), { numRuns: 500 })
  })
})

describe('App layout commands', () => {
  it('adds, edits, groups, moves, removes, and round-trips one gesture at a time', () => {
    const target = store()
    expect(add(target, { id: 'group', kind: 'group', title: 'Controls', children: [] }).ok).toBe(true)
    expect(add(target, { id: 'text', kind: 'text', role: 'body', text: 'Instructions' }, undefined, 0).ok).toBe(true)
    const controlOutcome = add(target, {
      id: 'control',
      kind: 'control',
      ref: { graphId: 'g0', nodeId: 'n1', inputId: 'seed' },
    })
    expect(controlOutcome.ok).toBe(true)
    if (controlOutcome.ok) {
      expect(controlOutcome.forward).toEqual([expect.objectContaining({
        op: 'add',
        path: ['ext', APP_LAYOUT_EXT_KEY, 'desktop', 'items', 2],
      })])
    }
    expect(add(target, {
      id: 'preview',
      kind: 'preview',
      ref: { graphId: 'g0', nodeId: 'n2' },
    }, 'group').ok).toBe(true)
    expect(add(target, {
      id: 'queue',
      kind: 'queue',
      label: 'Generate base',
      targets: [{ graphId: 'g0', nodeId: 'n1' }],
    }).ok).toBe(true)

    expect(target.dispatch({
      command: 'app.layout.setText',
      params: { id: 'text', text: '**Generate** a portrait with [help](https://example.test)', role: 'caption' },
    }).ok).toBe(true)
    expect(target.dispatch({
      command: 'app.layout.setGroupTitle', params: { id: 'group', title: 'Advanced controls' },
    }).ok).toBe(true)
    expect(target.dispatch({
      command: 'app.layout.setQueue', params: {
        id: 'queue',
        label: 'Upscale',
        targets: [
          { graphId: 'g0', nodeId: 'n2' },
          { graphId: 'g0', nodeId: 'n2' },
          { graphId: 'missing' },
        ],
      },
    }).ok).toBe(true)
    expect(currentLayout(target).desktop.items.find((item) => item.id === 'queue')).toEqual({
      id: 'queue', kind: 'queue', label: 'Upscale', targets: [{ graphId: 'g0', nodeId: 'n2' }],
    })
    expect(target.dispatch({
      command: 'app.layout.move', params: { id: 'control', parentId: 'group', index: 0 },
    }).ok).toBe(true)
    const noOp = target.dispatch({
      command: 'app.layout.move', params: { id: 'control', parentId: 'group', index: 0 },
    })
    expect(noOp.ok && noOp.forward).toEqual([])
    expect(currentLayout(target).desktop.items.find((item) => item.id === 'group')).toEqual({
      id: 'group',
      kind: 'group',
      title: 'Advanced controls',
      children: ['control', 'preview'],
    })

    expect(target.dispatch({
      command: 'app.layout.move', params: { id: 'preview', parentId: null, index: 0 },
    }).ok).toBe(true)
    expect(currentLayout(target).desktop.items.map((item) => item.id)).toEqual([
      'preview', 'text', 'group', 'control', 'queue',
    ])
    expect((currentLayout(target).desktop.items.find((item) => item.id === 'group') as any).children).toEqual(['control'])

    const beforeRemove = target.doc
    expect(target.dispatch({ command: 'app.layout.remove', params: { id: 'text' } }).ok).toBe(true)
    expect(currentLayout(target).desktop.items.some((item) => item.id === 'text')).toBe(false)
    expect(target.undo()).toBe(true)
    expect(target.doc).toEqual(beforeRemove)
    expect(target.redo()).toBe(true)
    expect(currentLayout(target).desktop.items.some((item) => item.id === 'text')).toBe(false)
  })

  it('allows stale registry refs but rejects duplicate placements and invalid structure', () => {
    const target = store()
    const stale = {
      id: 'stale',
      kind: 'control',
      ref: { graphId: 'missing', nodeId: 'gone', inputId: 'value' },
    }
    expect(add(target, stale).ok).toBe(true)
    expect(add(target, { ...stale, id: 'duplicate-ref' }).ok).toBe(false)
    expect(add(target, { id: 'stale', kind: 'text', role: 'body', text: 'duplicate id' }).ok).toBe(false)
    expect(add(target, { id: 'nested', kind: 'group', title: 'Nested', children: [] }, 'stale').ok).toBe(false)
    expect(target.dispatch({ command: 'app.layout.move', params: { id: 'missing', index: 0 } }).ok).toBe(false)
    expect(target.dispatch({ command: 'app.layout.setText', params: { id: 'stale', text: 'wrong kind' } }).ok).toBe(false)
    expect(target.dispatch({ command: 'app.layout.setGroupTitle', params: { id: 'stale', title: '' } }).ok).toBe(false)
  })

  it('repairs malformed placement indexes before applying a granular move', () => {
    const target = store(doc({ ext: { [APP_LAYOUT_EXT_KEY]: layoutJson([
      { id: 'a', kind: 'text', role: 'body', text: 'A', x: 2 },
      { id: 'b', kind: 'text', role: 'body', text: 'B' },
      { id: 'a', kind: 'text', role: 'body', text: 'duplicate' },
      { invalid: true },
      { id: 'first', kind: 'group', title: 'First', children: ['dead', 'a', 'a', 'b', 'second'] },
      { id: 'second', kind: 'group', title: 'Second', children: ['b'] },
    ]) } }))

    const outcome = target.dispatch({
      command: 'app.layout.move', params: { id: 'b', parentId: 'first', index: 0 },
    })
    expect(outcome.ok).toBe(true)
    expect(target.doc.ext?.[APP_LAYOUT_EXT_KEY]).toEqual(layoutJson([
      { id: 'a', kind: 'text', role: 'body', text: 'A', x: 2 },
      { id: 'b', kind: 'text', role: 'body', text: 'B' },
      { id: 'first', kind: 'group', title: 'First', children: ['b', 'a'] },
      { id: 'second', kind: 'group', title: 'Second', children: [] },
    ]))
    expect(outcome.ok && outcome.forward.every((patch) =>
      patch.path.slice(0, 4).join('.') === `ext.${APP_LAYOUT_EXT_KEY}.desktop.items`)).toBe(true)
  })

  it('sets and clears a top-level grid placement with collision push-down in one transaction', () => {
    const target = store(doc({ ext: { [APP_LAYOUT_EXT_KEY]: layoutJson([
      { id: 'a', kind: 'text', role: 'body', text: 'A', x: 0, y: 0, w: 6, h: 2 },
      { id: 'b', kind: 'text', role: 'body', text: 'B' },
      { id: 'c', kind: 'text', role: 'body', text: 'C', x: 0, y: 2, w: 6, h: 2 },
    ]) } }))
    const before = target.doc
    const outcome = target.dispatch({
      command: 'app.layout.setGrid',
      params: { id: 'b', grid: { x: 0, y: 0, w: 6, h: 2 } },
    })
    expect(outcome.ok).toBe(true)
    expect(currentLayout(target).desktop.items).toEqual([
      { id: 'a', kind: 'text', role: 'body', text: 'A', x: 0, y: 2, w: 6, h: 2 },
      { id: 'b', kind: 'text', role: 'body', text: 'B', x: 0, y: 0, w: 6, h: 2 },
      { id: 'c', kind: 'text', role: 'body', text: 'C', x: 0, y: 4, w: 6, h: 2 },
    ])
    expect(target.revision).toBe(1)
    expect(target.undo()).toBe(true)
    expect(target.doc).toEqual(before)
    expect(target.redo()).toBe(true)

    expect(target.dispatch({ command: 'app.layout.setGrid', params: { id: 'b', grid: null } }).ok).toBe(true)
    expect(appLayoutGrid(currentLayout(target).desktop.items[1]!)).toBeUndefined()
  })

  it('validates grid commands and strips coordinates when an item enters a group', () => {
    const target = store()
    expect(add(target, { id: 'group', kind: 'group', title: 'Group', children: [] }).ok).toBe(true)
    expect(add(target, { id: 'item', kind: 'text', role: 'body', text: 'Item', x: 0, y: 0, w: 6, h: 2 }).ok).toBe(true)
    const invalid = [
      { x: 0, y: 0, w: 6 },
      { x: -1, y: 0, w: 6, h: 1 },
      { x: 0, y: -1, w: 6, h: 1 },
      { x: 0, y: 0, w: 0, h: 1 },
      { x: 8, y: 0, w: 5, h: 1 },
      { x: 0.5, y: 0, w: 6, h: 1 },
      { x: 0, y: Number.MAX_VALUE, w: 6, h: 1 },
      { x: 0, y: Number.MAX_SAFE_INTEGER, w: 6, h: 1 },
    ]
    for (const grid of invalid) {
      expect(target.dispatch({ command: 'app.layout.setGrid', params: { id: 'item', grid } }).ok).toBe(false)
    }
    expect(target.dispatch({
      command: 'app.layout.move', params: { id: 'item', parentId: 'group', index: 0 },
    }).ok).toBe(true)
    expect(appLayoutGrid(currentLayout(target).desktop.items.find((item) => item.id === 'item')!)).toBeUndefined()
    expect(target.dispatch({
      command: 'app.layout.setGrid', params: { id: 'item', grid: { x: 0, y: 0, w: 6, h: 2 } },
    }).ok).toBe(false)
  })

  it('customizes, moves, resets, and round-trips mobile order one intention at a time', () => {
    const target = store(doc({ ext: { [APP_LAYOUT_EXT_KEY]: layoutJson([
      { id: 'flow', kind: 'text', role: 'body', text: 'Flow' },
      { id: 'right', kind: 'text', role: 'body', text: 'Right', x: 6, y: 0, w: 6, h: 1 },
      { id: 'left', kind: 'text', role: 'body', text: 'Left', x: 0, y: 0, w: 6, h: 1 },
    ]) } }))
    const automatic = target.doc

    const first = target.dispatch({ command: 'app.layout.moveMobile', params: { id: 'flow', index: 0 } })
    expect(first.ok).toBe(true)
    expect(currentLayout(target).mobile).toEqual({
      customized: true,
      items: [],
      order: ['flow', 'left', 'right'],
    })
    expect(target.revision).toBe(1)
    expect(target.undo()).toBe(true)
    expect(target.doc).toEqual(automatic)
    expect(target.redo()).toBe(true)

    const second = target.dispatch({ command: 'app.layout.moveMobile', params: { id: 'right', index: 0 } })
    expect(second.ok).toBe(true)
    expect(second.ok && second.forward.every((patch) =>
      patch.path.slice(0, 4).join('.') === `ext.${APP_LAYOUT_EXT_KEY}.mobile.order`)).toBe(true)
    expect(currentLayout(target).mobile).toEqual({
      customized: true,
      items: [],
      order: ['right', 'flow', 'left'],
    })

    const reset = target.dispatch({ command: 'app.layout.resetMobile', params: {} })
    expect(reset.ok).toBe(true)
    expect(currentLayout(target).mobile).toEqual({ customized: false, items: [] })
    expect(target.undo()).toBe(true)
    expect(currentLayout(target).mobile).toEqual({
      customized: true,
      items: [],
      order: ['right', 'flow', 'left'],
    })
  })

  it('appends missing ids, skips stale ids, and prunes removed placements from mobile order', () => {
    const target = store(doc({ ext: { [APP_LAYOUT_EXT_KEY]: {
      version: 1,
      desktop: { items: [
        { id: 'a', kind: 'text', role: 'body', text: 'A' },
        { id: 'b', kind: 'text', role: 'body', text: 'B' },
        { id: 'c', kind: 'text', role: 'body', text: 'C' },
      ] },
      mobile: { customized: true, items: [], order: ['stale', 'b', 4, 'b'] },
    } } }))
    expect(currentLayout(target).mobile).toEqual({ customized: true, items: [], order: ['b', 'a', 'c'] })

    const moved = target.dispatch({ command: 'app.layout.moveMobile', params: { id: 'c', index: 0 } })
    expect(moved.ok).toBe(true)
    expect(target.doc.ext?.[APP_LAYOUT_EXT_KEY]).toMatchObject({
      mobile: { customized: true, items: [], order: ['c', 'b', 'a'] },
    })
    expect(target.dispatch({ command: 'app.layout.remove', params: { id: 'b' } }).ok).toBe(true)
    expect(target.doc.ext?.[APP_LAYOUT_EXT_KEY]).toMatchObject({
      mobile: { customized: true, items: [], order: ['c', 'a'] },
    })
  })
})
