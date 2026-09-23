import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import type { GraphDef, Json, WorkflowDocument } from '../src/format/document.js'
import {
  asGraphDefId,
  asLineageId,
  asLinkId,
  asNetId,
  asNodeId,
  asPortId,
} from '../src/ids.js'
import type { ReplacementRule } from '../src/replace/model.js'
import { planReplacement, REPLACEMENT_MIGRATION_ARCHIVE_EXT_KEY } from '../src/replace/plan.js'
import { createReplacementRegistry } from '../src/replace/registry.js'
import { replacementInvocation, scanReplacements } from '../src/replace/scan.js'
import { parseDinksterNodes, type DinksterWireSchema, type InputSpec, type NodeSchema } from '../src/index.js'

const fixture = JSON.parse(readFileSync(
  new URL('../fixtures/replacements/same-type-migration.json', import.meta.url),
  'utf8',
)) as DinksterWireSchema & { nodeType: string }

const decoded = parseDinksterNodes({
  schemaVersion: 1,
  nodes: { [fixture.nodeType]: fixture },
})
expect(decoded.diagnostics).toEqual([])

const schema = decoded.schemas.get(fixture.nodeType)!
const rule = schema.replacements![0]!
const resolve = (type: string): NodeSchema | undefined => decoded.schemas.get(type)
const registry = createReplacementRegistry()
expect(registry.register('schema', rule)).toEqual([])

const replacementStore = (document: WorkflowDocument, schemaResolver = resolve): DocumentStore => new DocumentStore(
  document,
  coreCommandRegistry(),
  200,
  undefined,
  () => ({ kind: 'initial', schemaResolverFor: () => schemaResolver }),
)

const port = (node: string, id: string) => ({ node: asNodeId(node), port: asPortId(id) })
type MutableMigrationDocument = {
  graphs: Record<string, {
    nodes: Record<string, {
      values: Record<string, Json>
      controllers?: Record<string, 'increment'>
    }>
    links: Record<string, GraphDef['links'][string]>
    nets: Record<string, GraphDef['nets'][string]>
    boundary?: GraphDef['boundary']
  }>
  view: {
    graphs: Record<string, {
      nodes: Record<string, { views?: Record<string, string> }>
    }>
  }
}

function graph(partial: Omit<Partial<GraphDef>, 'id'> & { id: string }): GraphDef {
  return {
    name: 'same-type migration',
    nodes: {},
    links: {},
    nets: {},
    reroutes: {},
    nextOrdinal: 100,
    ...partial,
    id: asGraphDefId(partial.id),
  }
}

function historicalDocument(withActiveBoundary = false): WorkflowDocument {
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: asLineageId('same-type-migration'),
    root: asGraphDefId('g0'),
    graphs: {
      g0: graph({
        id: 'g0',
        nodes: {
          image: { id: asNodeId('image'), type: 'fixture.image', values: {} },
          color: { id: asNodeId('color'), type: 'fixture.integer', values: {} },
          mask: {
            id: asNodeId('mask'),
            type: 'dinkster.image.to_mask',
            values: {
              policy: 'tolerance_color',
              color_source: 'integer',
              color_value: 0x123456,
              tolerance: 0.125,
              metric: 'euclidean_rgb_sum',
              invert: true,
            },
            controllers: { color_value: 'increment' },
          },
          sink: { id: asNodeId('sink'), type: 'fixture.mask_sink', values: {} },
        },
        links: {
          l_image: { id: asLinkId('l_image'), from: port('image', 'image'), to: port('mask', 'image') },
          l_color: { id: asLinkId('l_color'), from: port('color', 'value'), to: port('mask', 'color_value') },
          l_mask: { id: asLinkId('l_mask'), from: port('mask', 'mask'), to: port('sink', 'mask') },
          tap_color: {
            id: asLinkId('tap_color'),
            from: { node: asNodeId('mask'), tap: asPortId('color_value') },
            to: port('sink', 'tap'),
          },
        },
        ...(withActiveBoundary
          ? {
              boundary: {
                inputs: [{
                  id: 'color',
                  binds: { kind: 'port' as const, ...port('mask', 'color_value') },
                  promoted: true,
                }],
                outputs: [{ id: 'mask', binds: { kind: 'port' as const, ...port('mask', 'mask') } }],
              },
            }
          : {}),
      }),
    },
    view: {
      graphs: {
        g0: {
          nodes: {
            mask: {
              position: { x: 40, y: 80 },
              views: { color_value: 'number.slider', invert: 'boolean.toggle' },
            },
          },
        },
      },
    },
  }
}

function stateFreeDocument(): WorkflowDocument {
  const before = historicalDocument()
  const { boundary: _boundary, ...def } = before.graphs.g0!
  return {
    ...before,
    graphs: {
      g0: {
        ...def,
        links: {},
        nets: {},
        nodes: {
          ...def.nodes,
          mask: { id: asNodeId('mask'), type: 'dinkster.image.to_mask', values: {} },
        },
      },
    },
    view: { graphs: {} },
  }
}

function historicalNetDocument(): WorkflowDocument {
  const before = historicalDocument()
  const def = before.graphs.g0!
  return {
    ...before,
    graphs: {
      g0: {
        ...def,
        links: Object.fromEntries(Object.entries(def.links).filter(([id]) => id !== 'l_color')),
        nets: {
          n_color: {
            id: asNetId('n_color'),
            name: 'color',
            source: port('color', 'value'),
            sinks: [port('mask', 'color_value')],
          },
        },
      },
    },
  }
}

describe('wire-28 same-type stored-workflow migration', () => {
  it('decodes seven guarded ImageToMask cases plus the default fallback', () => {
    expect(rule).toEqual((fixture.replacements as typeof schema.replacements)![0])
    expect(rule.migration?.historicalInputs).toContain('color_source')
    expect(rule.cases).toHaveLength(8)
    expect(rule.cases.slice(0, 7).every((candidate) => candidate.when !== undefined)).toBe(true)
    expect(rule.cases[7]!.when).toBeUndefined()
  })

  it.each([
    [0, { policy: 'channel', channel: 'green' }, { policy: { selected: 'channel' } }, { 'policy.channel': 'green' }],
    [1, { policy: 'exact_color', color_source: 'hex', color: '#123456' }, {
      policy: { selected: 'exact_color' },
      'policy.color_source': { selected: 'hex' },
    }, { 'policy.color_source.color': '#123456' }],
    [2, { policy: 'exact_color', color_source: 'integer', color_value: 0x123456 }, {
      policy: { selected: 'exact_color' },
      'policy.color_source': { selected: 'integer' },
    }, { 'policy.color_source.color_value': 0x123456 }],
    [3, { policy: 'exact_color', color_source: 'channels', red: 1, green: 2, blue: 3 }, {
      policy: { selected: 'exact_color' },
      'policy.color_source': { selected: 'channels' },
    }, {
      'policy.color_source.red': 1,
      'policy.color_source.green': 2,
      'policy.color_source.blue': 3,
    }],
    [4, { policy: 'tolerance_color', color_source: 'hex', color: '#123456', tolerance: 0.2 }, {
      policy: { selected: 'tolerance_color' },
      'policy.color_source': { selected: 'hex' },
    }, { 'policy.color_source.color': '#123456', 'policy.tolerance': 0.2 }],
    [5, { policy: 'tolerance_color', color_source: 'integer', color_value: 0x123456, tolerance: 0.2 }, {
      policy: { selected: 'tolerance_color' },
      'policy.color_source': { selected: 'integer' },
    }, { 'policy.color_source.color_value': 0x123456, 'policy.tolerance': 0.2 }],
    [6, { policy: 'tolerance_color', color_source: 'channels', red: 1, green: 2, blue: 3, tolerance: 0.2 }, {
      policy: { selected: 'tolerance_color' },
      'policy.color_source': { selected: 'channels' },
    }, {
      'policy.color_source.red': 1,
      'policy.color_source.green': 2,
      'policy.color_source.blue': 3,
      'policy.tolerance': 0.2,
    }],
  ] as const)(
    'plans guarded literal-choice case %i from historical values',
    (caseIndex, historicalValues, dynamic, values) => {
      const before = stateFreeDocument()
      ;(before.graphs.g0!.nodes.mask!.values as Record<string, Json>) = { ...historicalValues }
      const planned = planReplacement(before, 'g0', 'mask', rule, resolve)
      expect(planned.diagnostics).toEqual([])
      expect(planned.plan).toMatchObject({ caseIndex, dynamic, values })
    },
  )

  it.each([
    [{ channel: 'green' }, 0, { policy: { selected: 'channel' } }],
    [{ policy: 'exact_color', color: '#123456' }, 1, {
      policy: { selected: 'exact_color' },
      'policy.color_source': { selected: 'hex' },
    }],
    [{ policy: 'tolerance_color', color: '#123456' }, 4, {
      policy: { selected: 'tolerance_color' },
      'policy.color_source': { selected: 'hex' },
    }],
  ] as const)(
    'uses historical selector defaults without an old runtime schema',
    (historicalValues, caseIndex, dynamic) => {
      const before = stateFreeDocument()
      ;(before.graphs.g0!.nodes.mask!.values as Record<string, Json>) = { ...historicalValues }
      expect(planReplacement(before, 'g0', 'mask', rule, resolve).plan).toMatchObject({
        caseIndex,
        dynamic,
      })
    },
  )

  it('resolves the current target schema without consulting a historical source schema', () => {
    const before = stateFreeDocument()
    ;(before.graphs.g0!.nodes.mask!.values as Record<string, Json>) = {
      policy: 'exact_color',
      color_source: 'integer',
      color_value: 0x123456,
    }
    const calls: Array<{ type: string; role: 'source' | 'target' }> = []
    const planned = planReplacement(before, 'g0', 'mask', rule, (type, role) => {
      calls.push({ type, role })
      return role === 'target' ? decoded.schemas.get(type) : undefined
    })

    expect(planned.diagnostics).toEqual([])
    expect(planned.plan?.values['policy.color_source.color_value']).toBe(0x123456)
    expect(calls).toEqual([{ type: 'dinkster.image.to_mask', role: 'target' }])
  })

  it('selects a migration case from historical dynamic-choice paths', () => {
    const base = stateFreeDocument()
    const before: WorkflowDocument = {
      ...base,
      graphs: {
        ...base.graphs,
        g0: {
          ...base.graphs.g0!,
          nodes: {
            ...base.graphs.g0!.nodes,
            mask: {
              ...base.graphs.g0!.nodes.mask!,
              values: { 'legacy.policy.channel': 'green' },
              dynamic: { 'legacy.policy': { selected: 'channel' } },
            },
          },
        },
      },
    }
    const dynamicMigrationRule = {
      from: 'dinkster.image.to_mask',
      migration: { historicalInputs: ['legacy.policy', 'legacy.policy.channel'] },
      cases: [{
        to: 'dinkster.image.to_mask',
        when: { kind: 'valueEquals' as const, input: 'legacy.policy', value: 'channel' },
        slotVariants: { policy: 'channel' },
        inputs: {
          'policy.channel': { kind: 'copy' as const, input: 'legacy.policy.channel' },
        },
      }, {
        to: 'dinkster.image.to_mask',
        slotVariants: { policy: 'channel' },
      }],
    }

    const planned = planReplacement(before, 'g0', 'mask', dynamicMigrationRule, resolve)
    expect(planned.diagnostics).toEqual([])
    expect(planned.plan).toMatchObject({
      caseIndex: 0,
      dynamic: { policy: { selected: 'channel' } },
      values: { 'policy.channel': 'green' },
      migrationArchive: { node: before.graphs.g0!.nodes.mask },
    })
  })

  it('plans and atomically applies the nested tolerance/integer migration', () => {
    const before = historicalDocument(true)
    const planned = planReplacement(before, 'g0', 'mask', rule, resolve)
    expect(planned.diagnostics).toEqual([])
    expect(planned.plan).toMatchObject({
      from: 'dinkster.image.to_mask',
      to: 'dinkster.image.to_mask',
      caseIndex: 5,
      dynamic: {
        policy: { selected: 'tolerance_color' },
        'policy.color_source': { selected: 'integer' },
      },
      values: {
        'policy.color_source.color_value': 0x123456,
        'policy.tolerance': 0.125,
        'policy.metric': 'euclidean_rgb_sum',
        invert: true,
      },
      controllers: { 'policy.color_source.color_value': 'increment' },
      inputRewires: [{ link: 'l_color', port: 'policy.color_source.color_value' }],
      tapRewires: [{
        link: 'tap_color',
        fromTap: 'color_value',
        tap: 'policy.color_source.color_value',
      }],
      inputViewRewires: [{ fromInput: 'color_value', input: 'policy.color_source.color_value' }],
      boundaryRewires: [{
        item: 'color',
        side: 'input',
        fromPort: 'color_value',
        port: 'policy.color_source.color_value',
      }],
    })

    const items = scanReplacements(before, registry, resolve)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ status: 'terminal', safe: true, terminalType: 'dinkster.image.to_mask' })
    const invocation = replacementInvocation(items)!
    const store = replacementStore(before)
    const appliedResult = store.dispatch(invocation)
    expect(appliedResult.diagnostics).toEqual([])
    expect(appliedResult.ok).toBe(true)

    const applied = store.doc.graphs.g0!
    expect(applied.nodes.mask).toMatchObject({
      id: 'mask',
      type: 'dinkster.image.to_mask',
      dynamic: {
        policy: { selected: 'tolerance_color' },
        'policy.color_source': { selected: 'integer' },
      },
      controllers: { 'policy.color_source.color_value': 'increment' },
      ext: {
        [REPLACEMENT_MIGRATION_ARCHIVE_EXT_KEY]: {
          version: 1,
          node: before.graphs.g0!.nodes.mask,
        },
      },
    })
    expect(applied.nodes.mask!.values).not.toHaveProperty('policy')
    expect(applied.nodes.mask!.values).not.toHaveProperty('color_source')
    expect(applied.links.l_image!.to).toEqual(port('mask', 'image'))
    expect(applied.links.l_color!.to).toEqual(port('mask', 'policy.color_source.color_value'))
    expect(applied.links.l_mask!.from).toEqual(port('mask', 'mask'))
    expect(applied.links.tap_color!.from).toEqual({
      node: asNodeId('mask'),
      tap: asPortId('policy.color_source.color_value'),
    })
    expect(applied.boundary).toEqual({
      inputs: [{
        id: 'color',
        binds: { kind: 'port', ...port('mask', 'policy.color_source.color_value') },
        promoted: true,
      }],
      outputs: [{ id: 'mask', binds: { kind: 'port', ...port('mask', 'mask') } }],
    })
    expect(store.doc.view.graphs.g0!.nodes.mask).toEqual({
      position: { x: 40, y: 80 },
      views: {
        'policy.color_source.color_value': 'number.slider',
        invert: 'boolean.toggle',
      },
    })
    expect(scanReplacements(store.doc, registry, resolve)).toEqual([])

    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(before)
    expect(store.redo()).toBe(true)
    expect(store.doc.graphs.g0!.nodes.mask!.dynamic).toEqual(planned.plan!.dynamic)
    expect(store.doc.graphs.g0!.links.l_color!.to).toEqual(port('mask', 'policy.color_source.color_value'))
    expect(store.doc.graphs.g0!.links.tap_color!.from).toEqual({
      node: asNodeId('mask'),
      tap: asPortId('policy.color_source.color_value'),
    })
  })

  it('rewires an active historical net sink', () => {
    const withNet = historicalNetDocument()
    const planned = planReplacement(withNet, 'g0', 'mask', rule, resolve)
    expect(planned.diagnostics).toEqual([])
    expect(planned.plan?.netSinks).toEqual([{
      net: 'n_color',
      sinks: [port('mask', 'policy.color_source.color_value')],
    }])
  })

  it('declines an all-default node with no retired state or references', () => {
    const flatDefault = stateFreeDocument()
    const planned = planReplacement(flatDefault, 'g0', 'mask', rule, resolve)
    expect(planned).toEqual({ diagnostics: [] })
    expect(scanReplacements(flatDefault, registry, resolve)).toEqual([])
  })

  it.each([
    ['stored value', (document: MutableMigrationDocument) => {
      document.graphs.g0!.nodes.mask!.values.channel = 'green'
    }],
    ['controller', (document: MutableMigrationDocument) => {
      document.graphs.g0!.nodes.mask!.controllers = { channel: 'increment' }
    }],
    ['incoming link', (document: MutableMigrationDocument) => {
      document.graphs.g0!.links.channel = {
        id: asLinkId('channel'),
        from: port('color', 'value'),
        to: port('mask', 'channel'),
      }
    }],
    ['net sink', (document: MutableMigrationDocument) => {
      document.graphs.g0!.nets.channel = {
        id: asNetId('channel'),
        name: 'channel',
        source: port('color', 'value'),
        sinks: [port('mask', 'channel')],
      }
    }],
    ['boundary binding', (document: MutableMigrationDocument) => {
      document.graphs.g0!.boundary = {
        inputs: [{ id: 'channel', binds: { kind: 'port', ...port('mask', 'channel') } }],
        outputs: [],
      }
    }],
    ['widget tap', (document: MutableMigrationDocument) => {
      document.graphs.g0!.links.channel = {
        id: asLinkId('channel'),
        from: { node: asNodeId('mask'), tap: asPortId('channel') },
        to: port('sink', 'tap'),
      }
    }],
    ['input view', (document: MutableMigrationDocument) => {
      document.view.graphs.g0 = { nodes: { mask: { views: { channel: 'text.combo' } } } }
    }],
  ] as const)('recognizes an isolated retired %s as migration evidence', (_label, mutate) => {
    const before = stateFreeDocument()
    mutate(before as unknown as MutableMigrationDocument)
    expect(planReplacement(before, 'g0', 'mask', rule, resolve).plan).toBeDefined()
  })

  it.each([
    ['current dynamic state', { values: { 'policy.channel': 'red' }, dynamic: { policy: { selected: 'channel' } } }],
    ['mixed old and new state', {
      values: { policy: 'channel', channel: 'green', 'policy.channel': 'red' },
      dynamic: { policy: { selected: 'channel' } },
    }],
  ] as const)('declines %s without diagnostics', (_label, state) => {
    const before = historicalDocument()
    const current: WorkflowDocument = {
      ...before,
      graphs: {
        g0: {
          ...before.graphs.g0!,
          links: {},
          nodes: { mask: { ...before.graphs.g0!.nodes.mask!, ...state } },
        },
      },
    }
    expect(planReplacement(current, 'g0', 'mask', rule, resolve)).toEqual({ diagnostics: [] })
    expect(scanReplacements(current, registry, resolve)).toEqual([])
  })

  it.each([
    ['selector controller', (document: MutableMigrationDocument) => {
      document.graphs.g0!.nodes.mask!.controllers = { policy: 'increment' }
    }],
    ['nested selector controller', (document: MutableMigrationDocument) => {
      document.graphs.g0!.nodes.mask!.controllers = { color_source: 'increment' }
    }],
    ['selector link', (document: MutableMigrationDocument) => {
      document.graphs.g0!.links.selector = {
        id: asLinkId('selector'),
        from: port('color', 'value'),
        to: port('mask', 'color_source'),
      }
    }],
    ['primary selector link', (document: MutableMigrationDocument) => {
      document.graphs.g0!.links.selector = {
        id: asLinkId('selector'),
        from: port('color', 'value'),
        to: port('mask', 'policy'),
      }
    }],
    ['inactive branch controller', (document: MutableMigrationDocument) => {
      document.graphs.g0!.nodes.mask!.controllers = { channel: 'increment' }
    }],
    ['inactive branch link', (document: MutableMigrationDocument) => {
      document.graphs.g0!.links.inactive = {
        id: asLinkId('inactive'),
        from: port('color', 'value'),
        to: port('mask', 'channel'),
      }
    }],
    ['inactive branch net sink', (document: MutableMigrationDocument) => {
      document.graphs.g0!.nets.n_inactive = {
        id: asNetId('n_inactive'),
        name: 'inactive',
        source: port('color', 'value'),
        sinks: [port('mask', 'channel')],
      }
    }],
    ['inactive branch widget tap', (document: MutableMigrationDocument) => {
      document.graphs.g0!.links.tap = {
        id: asLinkId('tap'),
        from: { node: asNodeId('mask'), tap: asPortId('channel') },
        to: port('sink', 'tap'),
      }
    }],
    ['malformed widget tap', (document: MutableMigrationDocument) => {
      document.graphs.g0!.links.tap = {
        id: asLinkId('tap'),
        from: { node: asNodeId('mask'), tap: asPortId('channel'), members: ['legacy'] },
        to: port('sink', 'tap'),
      } as unknown as GraphDef['links'][string]
    }],
  ] as const)('fails closed without mutation for %s', (_label, mutate) => {
    const before = historicalDocument()
    mutate(before as unknown as MutableMigrationDocument)
    const snapshot = structuredClone(before)
    const planned = planReplacement(before, 'g0', 'mask', rule, resolve)
    expect(planned.plan).toBeUndefined()
    expect(planned.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: expect.stringMatching(/^replace\.migration\.(selector|inactive)/),
    }))
    expect(planned.diagnostics).not.toContainEqual(expect.objectContaining({ code: 'replace.migration.archived' }))

    const items = scanReplacements(before, registry, resolve)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ status: 'blocked', safe: false, hops: [] })
    expect(replacementInvocation(items)).toBeUndefined()
    expect(before).toEqual(snapshot)
  })

  it('fails closed when a renamed historical case selector has a controller', () => {
    const before = stateFreeDocument()
    const mask = before.graphs.g0!.nodes.mask!
    ;(mask.values as Record<string, Json>).legacy_mode = 'red'
    ;(mask as { controllers?: Record<string, 'increment'> }).controllers = { legacy_mode: 'increment' }
    const renamedSelectorRule = {
      from: 'dinkster.image.to_mask',
      migration: { historicalInputs: ['legacy_mode'] },
      cases: [
        {
          to: 'dinkster.image.to_mask',
          when: { kind: 'valueEquals' as const, input: 'legacy_mode', value: 'red' },
          slotVariants: { policy: 'channel' },
          inputs: { 'policy.channel': { kind: 'copy' as const, input: 'legacy_mode' } },
        },
        {
          to: 'dinkster.image.to_mask',
          slotVariants: { policy: 'channel' },
        },
      ],
    }
    const planned = planReplacement(before, 'g0', 'mask', renamedSelectorRule, resolve)
    expect(planned.plan).toBeUndefined()
    expect(planned.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'replace.migration.selectorRuntime',
    }))
  })

  it.each([
    ['policy', (document: MutableMigrationDocument) => {
      document.graphs.g0!.nodes.mask!.values.policy = 'invalid'
    }],
    ['nested color selector', (document: MutableMigrationDocument) => {
      document.graphs.g0!.nodes.mask!.values.policy = 'exact_color'
      document.graphs.g0!.nodes.mask!.values.color_source = 'invalid'
    }],
  ] as const)(
    'uses the default branch and archives an unmatched historical %s value',
    (_label, mutate) => {
      const before = stateFreeDocument()
      mutate(before as unknown as MutableMigrationDocument)
      const snapshot = structuredClone(before)
      const planned = planReplacement(before, 'g0', 'mask', rule, resolve)
      expect(planned.plan).toMatchObject({
        caseIndex: 7,
        dynamic: { policy: { selected: 'channel' } },
      })
      expect(planned.diagnostics).toContainEqual(expect.objectContaining({
        severity: 'info',
        code: 'replace.migration.archived',
      }))
      expect(scanReplacements(before, registry, resolve)).toMatchObject([{
        status: 'terminal',
        safe: true,
        terminalType: 'dinkster.image.to_mask',
        hops: [{ plan: { caseIndex: 7 } }],
      }])

      const store = replacementStore(before)
      expect(store.dispatch({ command: 'node.replace', params: { plan: planned.plan } as unknown as Json }).ok).toBe(true)
      expect(store.doc.graphs.g0!.nodes.mask!.ext?.[REPLACEMENT_MIGRATION_ARCHIVE_EXT_KEY]).toMatchObject({
        node: snapshot.graphs.g0!.nodes.mask,
      })
    },
  )

  it.each([
    ['selector link', (document: MutableMigrationDocument) => {
      document.graphs.g0!.links.selector = {
        id: asLinkId('selector'),
        from: port('color', 'value'),
        to: port('mask', 'policy'),
      }
    }],
    ['inactive controller', (document: MutableMigrationDocument) => {
      document.graphs.g0!.nodes.mask!.controllers = { tolerance: 'increment' }
    }],
    ['inactive link', (document: MutableMigrationDocument) => {
      document.graphs.g0!.links.inactive = {
        id: asLinkId('inactive'),
        from: port('color', 'value'),
        to: port('mask', 'tolerance'),
      }
    }],
    ['inactive net', (document: MutableMigrationDocument) => {
      document.graphs.g0!.nets.inactive = {
        id: asNetId('inactive'),
        name: 'inactive',
        source: port('color', 'value'),
        sinks: [port('mask', 'tolerance')],
      }
    }],
    ['inactive widget tap', (document: MutableMigrationDocument) => {
      document.graphs.g0!.links.tap = {
        id: asLinkId('tap'),
        from: { node: asNodeId('mask'), tap: asPortId('tolerance') },
        to: port('sink', 'tap'),
      }
    }],
    ['inactive boundary binding', (document: MutableMigrationDocument) => {
      document.graphs.g0!.boundary = {
        inputs: [{ id: 'tolerance', binds: { kind: 'port', ...port('mask', 'tolerance') } }],
        outputs: [],
      }
    }],
    ['member-addressed selector boundary', (document: MutableMigrationDocument) => {
      document.graphs.g0!.boundary = {
        inputs: [{
          id: 'policy',
          binds: { kind: 'port', ...port('mask', 'policy'), members: ['outer', 'inner'] },
        }],
        outputs: [],
      } as unknown as GraphDef['boundary']
    }],
  ] as const)('does not apply an unknown-selector fallback with %s', (_label, mutate) => {
    const before = stateFreeDocument()
    ;(before.graphs.g0!.nodes.mask!.values as Record<string, Json>).policy = 'invalid'
    mutate(before as unknown as MutableMigrationDocument)
    const snapshot = structuredClone(before)
    const planned = planReplacement(before, 'g0', 'mask', rule, resolve)
    expect(planned.plan).toBeUndefined()
    expect(planned.diagnostics).toContainEqual(expect.objectContaining({ severity: 'error' }))
    expect(replacementInvocation(scanReplacements(before, registry, resolve))).toBeUndefined()
    expect(before).toEqual(snapshot)
  })

  it('leaves unrelated malformed widget taps outside migration evidence and archival', () => {
    const before = stateFreeDocument()
    const mutable = before as unknown as MutableMigrationDocument
    mutable.graphs.g0!.nodes.mask!.values.policy = 'invalid'
    mutable.graphs.g0!.links.unrelated = {
      id: asLinkId('unrelated'),
      from: { node: asNodeId('mask'), tap: asPortId('unrelated'), members: ['legacy'] },
      to: port('sink', 'tap'),
    } as unknown as GraphDef['links'][string]
    const planned = planReplacement(before, 'g0', 'mask', rule, resolve)
    expect(planned.plan).toBeDefined()
    expect(planned.plan?.dropLinks).not.toContain('unrelated')
    expect(planned.plan?.migrationArchive).toMatchObject({ links: {} })

    const store = replacementStore(before)
    expect(store.dispatch({
      command: 'node.replace',
      params: { plan: planned.plan } as unknown as Json,
    }).ok).toBe(true)
    expect(store.doc.graphs.g0!.links.unrelated).toEqual(before.graphs.g0!.links.unrelated)

    const tapOnly = stateFreeDocument()
    ;(tapOnly.graphs.g0!.links as Record<string, GraphDef['links'][string]>).unrelated =
      before.graphs.g0!.links.unrelated!
    expect(planReplacement(tapOnly, 'g0', 'mask', rule, resolve)).toEqual({ diagnostics: [] })
  })

  it('requires migration plans to declare helper ownership before editing nets', () => {
    const before = historicalNetDocument()
    const plan = planReplacement(before, 'g0', 'mask', rule, resolve).plan!
    const { createdNodes: _createdNodes, ...malformed } = plan
    const changed = structuredClone(before)
    ;(changed.graphs.g0!.nets.n_color!.sinks as Array<ReturnType<typeof port>>)
      .push(port('sink', 'tap'))
    const store = replacementStore(changed)
    const outcome = store.dispatch({
      command: 'node.replace',
      params: { plan: malformed } as unknown as Json,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.diagnostics).toContainEqual(expect.objectContaining({ code: 'params.invalid' }))
    expect(store.doc).toEqual(changed)
  })

  it.each([
    ['value-only primary mapping', 'policy.channel', 'value', false],
    ['helper mapping', 'helper:policy.channel', 'copy', true],
  ] as const)('preserves a historical input view through a %s', (_label, targetInput, kind, helper) => {
    const before = stateFreeDocument()
    ;(before.graphs.g0!.nodes.mask!.values as Record<string, Json>).legacy = 'green'
    ;(before as unknown as MutableMigrationDocument).view.graphs.g0 = {
      nodes: { mask: { views: { legacy: 'text.combo' } } },
    }
    const viewRule = {
      from: 'dinkster.image.to_mask',
      migration: { historicalInputs: ['legacy'] },
      cases: [{
        to: 'dinkster.image.to_mask',
        when: { kind: 'valuePresent' as const, input: 'legacy' },
        ...(helper ? { nodes: { helper: { type: 'dinkster.image.to_mask' } } } : {}),
        slotVariants: {
          policy: 'channel',
          ...(helper ? { 'helper:policy': 'channel' } : {}),
        },
        inputs: { [targetInput]: { kind, input: 'legacy' } },
      }, {
        to: 'dinkster.image.to_mask',
        slotVariants: { policy: 'channel' },
      }],
    }
    const planned = planReplacement(before, 'g0', 'mask', viewRule, resolve)
    expect(planned.diagnostics).toEqual([])
    expect(planned.plan?.dropInputViews).toBeUndefined()
    expect(planned.plan?.viewRewires).toEqual([{
      from: 'legacy',
      to: 'policy.channel',
      ...(helper ? { node: 'mask:helper' } : {}),
    }])

    const store = replacementStore(before)
    const outcome = store.dispatch({
      command: 'node.replace',
      params: { plan: planned.plan } as unknown as Json,
    })
    expect(outcome.diagnostics).toEqual([])
    expect(outcome.ok).toBe(true)
    const targetNode = helper ? 'mask:helper' : 'mask'
    expect(store.doc.view.graphs.g0!.nodes[targetNode]!.views).toEqual({
      'policy.channel': 'text.combo',
    })
    expect(store.doc.view.graphs.g0!.nodes.mask!.views).not.toHaveProperty('legacy')

    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(before)
    expect(store.redo()).toBe(true)
    expect(store.doc.view.graphs.g0!.nodes[targetNode]!.views).toEqual({
      'policy.channel': 'text.combo',
    })
  })

  it('auto-migrates and archives a displaced inactive input view', () => {
    const before = historicalDocument()
    ;(before as unknown as MutableMigrationDocument).view.graphs.g0!.nodes.mask!.views!.channel = 'text.combo'
    const snapshot = structuredClone(before)
    const planned = planReplacement(before, 'g0', 'mask', rule, resolve)
    expect(planned.plan).toBeDefined()
    expect(planned.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'info',
      code: 'replace.migration.archived',
    }))

    const items = scanReplacements(before, registry, resolve)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ status: 'terminal', safe: true })
    const store = replacementStore(before)
    expect(store.dispatch(replacementInvocation(items)!).ok).toBe(true)
    const archive = store.doc.graphs.g0!.nodes.mask!.ext?.[REPLACEMENT_MIGRATION_ARCHIVE_EXT_KEY]
    expect(archive).toMatchObject({
      version: 1,
      node: snapshot.graphs.g0!.nodes.mask,
      links: { l_color: snapshot.graphs.g0!.links.l_color },
      view: snapshot.view.graphs.g0!.nodes.mask,
    })
    expect(store.doc.view.graphs.g0!.nodes.mask!.views).not.toHaveProperty('channel')
    expect(scanReplacements(store.doc, registry, resolve)).toEqual([])
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(snapshot)
  })

  it('rejects a malformed or stale migration archive without partial mutation', () => {
    const before = historicalDocument()
    const plan = planReplacement(before, 'g0', 'mask', rule, resolve).plan!

    const malformedStore = replacementStore(before)
    const malformed = malformedStore.dispatch({
      command: 'node.replace',
      params: { plan: { ...plan, migrationArchive: [] } } as unknown as Json,
    })
    expect(malformed.ok).toBe(false)
    expect(malformedStore.doc).toEqual(before)

    const changed = structuredClone(before)
    ;(changed.graphs.g0!.nodes.mask!.values as Record<string, Json>).tolerance = 0.5
    const staleStore = replacementStore(changed)
    const stale = staleStore.dispatch({ command: 'node.replace', params: { plan } as unknown as Json })
    expect(stale.ok).toBe(false)
    expect(stale.diagnostics).toContainEqual(expect.objectContaining({ code: 'replace.stale' }))
    expect(staleStore.doc).toEqual(changed)
  })

  it('rejects a fallback plan when an archived dropped output net changes', () => {
    const fallback = rule.cases.at(-1)!
    const { outputs: _outputs, ...fallbackWithoutOutputs } = fallback
    const outputDroppingRule = {
      ...rule,
      cases: [...rule.cases.slice(0, -1), fallbackWithoutOutputs],
    }
    const before = stateFreeDocument()
    const mutable = before as unknown as MutableMigrationDocument
    mutable.graphs.g0!.nodes.mask!.values.policy = 'invalid'
    mutable.graphs.g0!.nets.output = {
      id: asNetId('output'),
      name: 'output',
      source: port('mask', 'mask'),
      sinks: [port('sink', 'mask')],
    }
    const plan = planReplacement(before, 'g0', 'mask', outputDroppingRule, resolve).plan!
    expect(plan.dropNets).toEqual(['output'])
    expect(plan.migrationArchive).toMatchObject({
      nets: { output: before.graphs.g0!.nets.output },
    })

    const changed = structuredClone(before)
    ;(changed.graphs.g0!.nets.output!.sinks as Array<ReturnType<typeof port>>)
      .push(port('image', 'image'))
    const store = replacementStore(changed)
    const outcome = store.dispatch({ command: 'node.replace', params: { plan } as unknown as Json })
    expect(outcome.ok).toBe(false)
    expect(outcome.diagnostics).toContainEqual(expect.objectContaining({ code: 'replace.stale' }))
    expect(store.doc).toEqual(changed)
  })

  it('rejects stale archived historical links, nets, and widget taps', () => {
    const cases: Array<{
      before: WorkflowDocument
      mutate: (document: MutableMigrationDocument) => void
    }> = [
      {
        before: historicalDocument(),
        mutate: (document) => {
          const link = document.graphs.g0!.links.l_color!
          document.graphs.g0!.links.l_color = { ...link, to: port('mask', 'tolerance') }
        },
      },
      {
        before: historicalNetDocument(),
        mutate: (document) => {
          const net = document.graphs.g0!.nets.n_color!
          document.graphs.g0!.nets.n_color = { ...net, name: 'changed' }
        },
      },
      {
        before: historicalNetDocument(),
        mutate: (document) => {
          const net = document.graphs.g0!.nets.n_color!
          document.graphs.g0!.nets.n_color = { ...net, sinks: [port('mask', 'tolerance')] }
        },
      },
      {
        before: historicalDocument(),
        mutate: (document) => {
          const link = document.graphs.g0!.links.tap_color!
          document.graphs.g0!.links.tap_color = { ...link, to: port('sink', 'mask') }
        },
      },
      {
        before: historicalDocument(),
        mutate: (document) => {
          document.graphs.g0!.links.new_tap = {
            id: asLinkId('new_tap'),
            from: { node: asNodeId('mask'), tap: asPortId('channel'), members: ['legacy'] },
            to: port('sink', 'tap'),
          } as unknown as GraphDef['links'][string]
        },
      },
    ]
    for (const { before, mutate } of cases) {
      const plan = planReplacement(before, 'g0', 'mask', rule, resolve).plan!
      const changed = structuredClone(before)
      mutate(changed as unknown as MutableMigrationDocument)
      const store = replacementStore(changed)
      const result = store.dispatch({ command: 'node.replace', params: { plan } as unknown as Json })
      expect(result.ok).toBe(false)
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'replace.stale' }))
      expect(store.doc).toEqual(changed)
    }
  })

  it('atomically migrates sibling sinks on one historical net', () => {
    const before = historicalNetDocument()
    const def = before.graphs.g0!
    ;(def.nodes as Record<string, GraphDef['nodes'][string]>).mask2 = {
      ...structuredClone(def.nodes.mask!),
      id: asNodeId('mask2'),
    }
    ;(def.nets as Record<string, GraphDef['nets'][string]>).n_color = {
      ...def.nets.n_color!,
      sinks: [port('mask', 'color_value'), port('mask2', 'color_value')],
    }
    const snapshot = structuredClone(before)
    const items = scanReplacements(before, registry, resolve)
    expect(items).toHaveLength(2)
    expect(items.every((item) => item.safe)).toBe(true)
    expect(items.every((item) => item.hops.every((hop) => hop.plan.createdNodes?.length === 0)))
      .toBe(true)

    const store = replacementStore(before)
    expect(store.dispatch(replacementInvocation(items)!).ok).toBe(true)
    expect(store.doc.graphs.g0!.nets.n_color!.sinks).toEqual([
      port('mask', 'policy.color_source.color_value'),
      port('mask2', 'policy.color_source.color_value'),
    ])
    for (const nodeId of ['mask', 'mask2']) {
      expect(store.doc.graphs.g0!.nodes[nodeId]!.ext?.[REPLACEMENT_MIGRATION_ARCHIVE_EXT_KEY])
        .toMatchObject({ nets: { n_color: snapshot.graphs.g0!.nets.n_color } })
    }
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(snapshot)
  })
})

// SaveVideo wire export and normalized AssembleVideo.define_schema from
// https://github.com/Kosinkadink/Dinkster/commit/4258cb557cb684f8723c4dc0cf022b4a65e48baa
describe('published Save Video v3 migration', () => {
  const videoFixture = JSON.parse(readFileSync(
    new URL('../fixtures/replacements/save-video-v3-wire38.json', import.meta.url),
    'utf8',
  )) as DinksterWireSchema & { nodeType: string }
  const decodedVideo = parseDinksterNodes({
    schemaVersion: 1,
    nodes: { [videoFixture.nodeType]: videoFixture },
  })
  expect(decodedVideo.diagnostics).toEqual([])
  expect(videoFixture).toMatchObject({ nodeType: 'dinkster.save_video', version: 3, schemaVersion: 1 })

  const input = (id: string, name: string, extra: Partial<InputSpec> = {}): InputSpec => ({
    kind: 'input', id, type: { kind: 'concrete', name }, optional: false, ...extra,
  })
  const video = { kind: 'concrete', name: 'comfy.VIDEO' } as const
  const schemas: Record<string, NodeSchema> = {
    'dinkster.save_video': decodedVideo.schemas.get('dinkster.save_video')!,
    'dinkster.video.assemble': {
      type: 'dinkster.video.assemble', displayName: 'Assemble Video', category: 'video',
      source: 'v3', isOutputNode: false,
      items: [
        input('images', 'dinkster.image'),
        input('fps', 'core.float', {
          optional: true, widget: { widgetType: 'NUMBER', options: { min: 0.01, max: 1000, step: 0.01 }, default: 24 },
        }),
        input('bit_depth', 'core.combo', {
          optional: true, widget: { widgetType: 'COMBO', options: { options: ['auto', '8', '10'] }, default: 'auto' },
        }),
        input('color_space', 'core.combo', {
          optional: true, widget: { widgetType: 'COMBO', options: { options: ['sRGB', 'HDR', 'HDR PQ'] } },
        }),
        input('audio', 'comfy.AUDIO', { optional: true }),
        { kind: 'output', id: 'video', type: video, preview: true },
      ],
    },
  }
  const resolveVideo = (type: string): NodeSchema | undefined => schemas[type]
  const videoRule = schemas['dinkster.save_video']!.replacements![0]!

  function videoDocument(values: Record<string, Json> = {}): WorkflowDocument {
    return {
      format: 'dinkster-workflow', formatVersion: 1,
      lineage: asLineageId('save-video-migration'), root: asGraphDefId('g0'),
      graphs: {
        g0: graph({
          id: 'g0',
          nodes: {
            save: {
              id: asNodeId('save'), type: 'dinkster.save_video',
              values: {
                fps: 24, 'format.crf': 31, 'format.bit_depth': '10',
                target: { mount: 'output', prefix: 'migration/video' },
                ...values,
              },
              dynamic: { format: { selected: 'webm_av1' } },
            },
          },
        }),
      },
      view: { graphs: {} },
    }
  }

  it.each([
    [{}, 'webm_av1'],
    [{ format: 'mp4_h264' }, 'mp4_h264'],
    [{ format: null }, null],
  ] as const)('copies the stored selector with explicit value precedence: %j', (values, expected) => {
    const planned = planReplacement(videoDocument(values), 'g0', 'save', videoRule, resolveVideo)
    expect(planned.diagnostics.filter((diagnostic) => diagnostic.severity !== 'info')).toEqual([])
    expect(planned.plan?.values.format).toBe(expected)
    expect(planned.plan?.dynamic).toBeUndefined()
  })

  it.each([
    [{}, 'webm_vp9'],
    [{ format: 'mp4_h264' }, 'webm_av1'],
  ] as const)('uses the same precedence before an explicit enum transform: %j', (values, expected) => {
    const transformed: ReplacementRule = {
      ...videoRule,
      cases: videoRule.cases.map((candidate) => ({
        ...candidate,
        inputs: {
          ...candidate.inputs,
          format: {
            kind: 'value', input: 'format',
            transform: { kind: 'enumRename', map: { webm_av1: 'webm_vp9', mp4_h264: 'webm_av1' } },
          },
        },
      })),
    }
    const planned = planReplacement(videoDocument(values), 'g0', 'save', transformed, resolveVideo)
    expect(planned.diagnostics.filter((diagnostic) => diagnostic.severity !== 'info')).toEqual([])
    expect(planned.plan?.values.format).toBe(expected)
  })

  it.each(['crf', 'bit_depth'].flatMap((key) =>
    ['value', 'link', 'net'].map((source) => ({ key, source })),
  ))('selects the nested case from $key $source alone', ({ key, source }) => {
    const before = videoDocument()
    const def = before.graphs.g0!
    const values = def.nodes.save!.values as Record<string, Json>
    delete values['format.crf']
    delete values['format.bit_depth']
    const historical = `format.${key}`
    const destination = port(key === 'crf' ? 'save' : 'save:assemble', key)
    if (source === 'value') values[historical] = key === 'crf' ? 31 : '10'
    else {
      ;(def.nodes as Record<string, GraphDef['nodes'][string]>).control = {
        id: asNodeId('control'), type: 'fixture.control', values: {},
      }
      if (source === 'link') {
        ;(def.links as Record<string, GraphDef['links'][string]>).l_control = {
          id: asLinkId('l_control'), from: port('control', 'value'), to: port('save', historical),
        }
      } else {
        ;(def.nets as Record<string, GraphDef['nets'][string]>).n_control = {
          id: asNetId('n_control'), name: 'control', source: port('control', 'value'), sinks: [port('save', historical)],
        }
      }
    }
    const planned = planReplacement(before, 'g0', 'save', videoRule, resolveVideo)
    expect(planned.diagnostics.filter((diagnostic) => diagnostic.severity !== 'info')).toEqual([])
    expect(planned.plan).toMatchObject({ caseIndex: 0, values: { format: 'webm_av1' } })
    expect(planned.plan!.createdNodes![0]!.values).toEqual({
      fps: 24, bit_depth: key === 'bit_depth' && source === 'value' ? '10' : 'auto', color_space: 'sRGB',
    })
    if (key === 'crf' && source === 'value') expect(planned.plan!.values.crf).toBe(31)
    else expect(planned.plan!.values).not.toHaveProperty('crf')
    if (source === 'link') {
      expect(planned.plan!.inputRewires).toEqual([{
        link: 'l_control', port: key, ...(key === 'bit_depth' ? { node: destination.node } : {}),
      }])
    }
    if (source === 'net') expect(planned.plan!.netSinks).toEqual([{ net: 'n_control', sinks: [destination] }])
    const store = replacementStore(before, resolveVideo)
    const result = store.dispatch({ command: 'node.replace', params: { plan: planned.plan! } as unknown as Json })
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity !== 'info')).toEqual([])
    expect(result.ok).toBe(true)
    const migrated = store.doc.graphs.g0!
    expect(migrated.nodes.save!.values).toEqual(planned.plan!.values)
    expect(migrated.nodes['save:assemble']!.values).toEqual(planned.plan!.createdNodes![0]!.values)
    if (source === 'link') expect(migrated.links.l_control!.to).toEqual(destination)
    if (source === 'net') expect(migrated.nets.n_control!.sinks).toEqual([destination])
  })

  it.each(['literal', 'link', 'net', 'flat'] as const)(
    'atomically migrates helpers, controls and asset consumers with a %s selector and undo/redo',
    (selector) => {
      const before = videoDocument()
      const def = before.graphs.g0!
      const save = def.nodes.save!
      if (selector === 'flat') {
        const { 'format.crf': crf, 'format.bit_depth': bit_depth, ...values } = save.values
        ;(def.nodes as Record<string, typeof save>).save = {
          id: save.id, type: save.type, values: { ...values, crf: crf!, bit_depth: bit_depth!, format: 'webm_av1' },
        }
      }
      for (const id of ['images', 'audio', 'format', 'sink']) {
        ;(def.nodes as Record<string, typeof save>)[id] = { id: asNodeId(id), type: `fixture.${id}`, values: {} }
      }
      for (const id of ['images', 'audio']) {
        ;(def.links as Record<string, GraphDef['links'][string]>)[`l_${id}`] = {
          id: asLinkId(`l_${id}`), from: port(id, id), to: port('save', id),
        }
      }
      ;(def.links as Record<string, GraphDef['links'][string]>).asset = {
        id: asLinkId('asset'), from: port('save', 'video'), to: port('sink', 'asset'),
      }
      if (selector === 'link') {
        ;(def.links as Record<string, GraphDef['links'][string]>).l_format = {
          id: asLinkId('l_format'), from: port('format', 'value'), to: port('save', 'format'),
        }
      }
      ;(def.nets as Record<string, GraphDef['nets'][string]>).asset_net = {
        id: asNetId('asset_net'), name: 'saved asset', source: port('save', 'video'), sinks: [port('sink', 'net')],
      }
      if (selector === 'net') {
        ;(def.nets as Record<string, GraphDef['nets'][string]>).format_net = {
          id: asNetId('format_net'), name: 'format', source: port('format', 'value'), sinks: [port('save', 'format')],
        }
      }
      const registry = createReplacementRegistry()
      expect(registry.register('schema', videoRule)).toEqual([])
      const items = scanReplacements(before, registry, resolveVideo)
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({ safe: true, status: 'terminal' })
      const store = replacementStore(before, resolveVideo)
      const result = store.dispatch(replacementInvocation(items)!)
      expect(result.diagnostics.filter((diagnostic) => diagnostic.severity !== 'info')).toEqual([])
      expect(result.ok).toBe(true)
      const after = store.doc
      const migrated = after.graphs.g0!
      expect(migrated.nodes.save!.values).toEqual({
        target: save.values.target, metadata: '{}',
        format: 'webm_av1', crf: 31, container: 'auto', codec: 'auto',
      })
      expect(migrated.nodes.save!.dynamic).toBeUndefined()
      expect(migrated.nodes.save!.ext?.[REPLACEMENT_MIGRATION_ARCHIVE_EXT_KEY])
        .toMatchObject({ node: before.graphs.g0!.nodes.save })
      expect(migrated.nodes['save:assemble']).toMatchObject({
        type: 'dinkster.video.assemble', values: { fps: 24, bit_depth: '10', color_space: 'sRGB' },
      })
      expect(Object.keys(migrated.nodes)).toHaveLength(Object.keys(def.nodes).length + 1)
      for (const id of ['images', 'audio']) {
        expect(migrated.links[`l_${id}`]!.to).toEqual(port('save:assemble', id))
      }
      expect(migrated.links.l100).toMatchObject({ from: port('save:assemble', 'video'), to: port('save', 'video') })
      expect(migrated.links.asset!.from).toEqual(port('save', 'asset'))
      expect(migrated.nets.asset_net!.source).toEqual(port('save', 'asset'))
      if (selector === 'link') expect(migrated.links.l_format).toEqual(def.links.l_format)
      if (selector === 'net') expect(migrated.nets.format_net).toEqual(def.nets.format_net)
      expect(scanReplacements(after, registry, resolveVideo)).toEqual([])
      expect(store.undo()).toBe(true)
      expect(store.doc).toEqual({
        ...before, graphs: { ...before.graphs, g0: { ...def, nextOrdinal: migrated.nextOrdinal } },
      })
      expect(store.redo()).toBe(true)
      expect(store.doc).toEqual(after)
    },
  )
})
