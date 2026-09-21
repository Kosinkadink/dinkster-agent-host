/**
 * Menu registry + core contribution tests: extensions and core use the SAME
 * registry, resolved output is plain data, and ordering is deterministic
 * (group lexicographic, then order, then contribution id).
 */
import { describe, expect, it } from 'vitest'
import {
  createMenuRegistry,
  type MenuActionItem,
  type MenuContext,
  type MenuContribution,
  type MenuItem,
  type MenuTarget,
} from '../src/menus/contract.js'
import { coreMenuContributions } from '../src/menus/core-items.js'
import type { GraphDef, WorkflowDocument } from '../src/format/document.js'
import { asGraphDefId, asLineageId, asNodeId, asSelectorCandidateId, asSelectorId, asValueSourceId } from '../src/ids.js'
import { registerCatalog } from '../src/i18n/index.js'

registerCatalog('en', { 'nodeHelp.action.help': 'Help' })

function graph(partial: Omit<Partial<GraphDef>, 'id'> & { id: string }): GraphDef {
  return {
    name: 'g',
    nodes: {},
    links: {},
    nets: {},
    reroutes: {},
    nextOrdinal: 100,
    ...partial,
    id: asGraphDefId(partial.id),
  }
}

const node = (id: string, type = 'KSampler', mode?: 'active' | 'muted' | 'bypassed') => ({
  id: asNodeId(id),
  type,
  values: {},
  ...(mode ? { mode } : {}),
})

function docWith(overrides?: Partial<WorkflowDocument>): WorkflowDocument {
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: asLineageId('lin1'),
    root: asGraphDefId('g0'),
    graphs: {
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1'), n2: node('n2', 'KSampler', 'muted'), s1: node('s1', '#sub1') },
      }),
      sub1: graph({ id: 'sub1', name: 'Sub' }),
    },
    view: { graphs: { g0: { nodes: { n1: { position: { x: 0, y: 0 }, size: { width: 300, height: 200 } } } } } },
    ...overrides,
  }
}

function ctx(target: MenuTarget, extra?: Partial<MenuContext>): MenuContext {
  return {
    doc: docWith(),
    graphId: 'g0',
    target,
    selection: { nodes: [], links: [], reroutes: [], valueSources: [], selectors: [] },
    worldX: 10,
    worldY: 20,
    ...extra,
  }
}

function coreRegistry() {
  const registry = createMenuRegistry()
  for (const c of coreMenuContributions()) registry.register(c)
  return registry
}

function menuDescendants(items: readonly MenuItem[]): MenuItem[] {
  return items.flatMap((item) => [item, ...menuDescendants(item.children ?? [])])
}

function requireAction(item: MenuItem): MenuActionItem {
  if (!item.action) throw new Error(`expected '${item.id}' to be an action item`)
  return item
}

describe('createMenuRegistry', () => {
  const item = (id: string) => ({ id, label: id, action: { kind: 'host', action: 'noop' } }) as const
  const contrib = (id: string, group: string, order?: number, targets: MenuTarget['kind'][] = ['canvas']): MenuContribution => ({
    id,
    targets,
    group,
    ...(order !== undefined ? { order } : {}),
    resolve: () => [item(`${id}.item`)],
  })

  it('rejects duplicate contribution ids and unregisters cleanly', () => {
    const reg = createMenuRegistry()
    const un = reg.register(contrib('a', '10'))
    expect(() => reg.register(contrib('a', '20'))).toThrow(/already registered/)
    un()
    expect(() => reg.register(contrib('a', '20'))).not.toThrow()
  })

  it('orders by group, then order, then id; merges same-group contributions', () => {
    const reg = createMenuRegistry()
    // Registration order is deliberately scrambled.
    reg.register(contrib('z.late', '10-nav', 5))
    reg.register(contrib('a.early', '10-nav', 1))
    reg.register(contrib('m.edit', '90-edit'))
    reg.register(contrib('b.default', '10-nav')) // order defaults to 0
    const groups = reg.resolve(ctx({ kind: 'canvas' }))
    expect(groups.map((g) => g.group)).toEqual(['10-nav', '90-edit'])
    expect(groups[0]!.items.map((i) => i.id)).toEqual(['b.default.item', 'a.early.item', 'z.late.item'])
  })

  it('filters by target kind and hides empty resolutions', () => {
    const reg = createMenuRegistry()
    reg.register(contrib('canvas.only', '10', 0, ['canvas']))
    reg.register(contrib('node.only', '10', 0, ['node']))
    reg.register({ id: 'hidden', targets: ['canvas'], group: '10', resolve: () => [] })
    const groups = reg.resolve(ctx({ kind: 'canvas' }))
    expect(groups.flatMap((g) => g.items.map((i) => i.id))).toEqual(['canvas.only.item'])
  })

  it('extension contributions interleave with core by group key', () => {
    const reg = coreRegistry()
    reg.register({
      id: 'ext.node.tools',
      targets: ['node'],
      group: '50-ext',
      resolve: () => [item('ext.node.tools.item')],
    })
    const groups = reg.resolve(ctx({ kind: 'node', nodeId: 'n1' }))
    const keys = groups.map((g) => g.group)
    // Core: 15-run, 20-mode, 30-layout, 90-edit for n1 (no subgraph nav) + ext 50-ext.
    expect(keys).toEqual(['15-run', '20-mode', '30-layout', '50-ext', '90-edit'])
  })

  it('resolved items are plain JSON-safe data', () => {
    const groups = coreRegistry().resolve(ctx({ kind: 'node', nodeId: 'n1' }))
    // Round-trips through JSON without loss: no functions/classes leak out.
    expect(JSON.parse(JSON.stringify(groups))).toEqual(groups)
  })
})

describe('core contributions', () => {
  it('node menu offers modes with the current mode checked', () => {
    const groups = coreRegistry().resolve(ctx({ kind: 'node', nodeId: 'n2' }))
    const mode = groups.find((g) => g.group === '20-mode')!.items[0]!
    expect(mode).toMatchObject({ id: 'core.node.mode', label: 'Mode' })
    expect(mode.children?.map((i) => `${i.id}:${i.checked}`)).toEqual([
      'core.node.mode.active:false',
      'core.node.mode.muted:true',
      'core.node.mode.bypassed:false',
    ])
    const muted = requireAction(mode.children![1]!)
    expect(muted.action).toEqual({
      kind: 'command',
      invocation: { command: 'node.setMode', params: { graphId: 'g0', nodeIds: ['n2'], mode: 'muted' } },
    })
    expect(mode.icon).toBe('sliders-horizontal')
    expect(muted.icon).toBe('volume-x')
  })

  it('offers make unique only for a multiply-linked subgraph occurrence', () => {
    const base = docWith()
    const shared = docWith({
      graphs: {
        ...base.graphs,
        g0: {
          ...base.graphs.g0!,
          nodes: {
            ...base.graphs.g0!.nodes,
            s2: node('s2', '#sub1'),
          },
        },
      },
    })
    const items = coreRegistry().resolve(ctx({ kind: 'node', nodeId: 's1' }, { doc: shared }))
      .flatMap((group) => group.items)
    expect(items.find((item) => item.id === 'core.node.localize')).toMatchObject({
      label: 'Make Unique',
      icon: 'copy-plus',
      action: { kind: 'command', invocation: { command: 'occurrence.localize', params: { graphId: 'g0', nodeId: 's1' } } },
    })
    expect(coreRegistry().resolve(ctx({ kind: 'node', nodeId: 's1' }))
      .flatMap((group) => group.items).some((item) => item.id === 'core.node.localize')).toBe(false)
  })

  it('carries only shortcuts backed by the supplied keybinding registry snapshot', () => {
    const groups = coreRegistry().resolve(ctx({ kind: 'node', nodeId: 'n1' }, {
      shortcuts: { 'edit.delete': 'Delete', 'node.mute': 'Ctrl+M' },
    }))
    const items = menuDescendants(groups.flatMap((group) => group.items))
    expect(items.find((item) => item.id === 'core.node.delete')?.shortcut).toBe('Delete')
    expect(items.find((item) => item.id === 'core.node.mode.muted')?.shortcut).toBe('Ctrl+M')
    expect(items.find((item) => item.id === 'core.node.copy')?.shortcut).toBeUndefined()
  })

  it('mode acts on the whole selection when the target rides it', () => {
    const c = ctx({ kind: 'node', nodeId: 'n1' }, { selection: { nodes: ['n1', 'n2'], links: [], reroutes: [], valueSources: [], selectors: [] } })
    const groups = coreRegistry().resolve(c)
    const mode = groups.find((g) => g.group === '20-mode')!.items[0]!
    const active = requireAction(mode.children![0]!)
    expect(active.action.kind).toBe('command')
    if (active.action.kind === 'command')
      expect(active.action.invocation.params).toMatchObject({ nodeIds: ['n1', 'n2'] })
    // Mixed modes: nothing checked.
    expect(mode.children!.every((i) => i.checked === false)).toBe(true)
    // Delete label reflects the count.
    const edit = groups.find((g) => g.group === '90-edit')!
    expect(edit.items.find((item) => item.id === 'core.node.copy')!.label).toBe('Copy Selected Nodes')
    expect(edit.items.find((item) => item.id === 'core.node.delete')!.label).toBe('Delete 2 Nodes')
  })

  it('minimizes or restores the whole selected node set with one command', () => {
    const selection = { nodes: ['n1', 'n2'], links: [], reroutes: [], valueSources: [], selectors: [] }
    const initial = coreRegistry().resolve(ctx({ kind: 'node', nodeId: 'n1' }, { selection }))
      .flatMap((group) => group.items)
      .find((item) => item.id === 'core.node.minimize')!
    expect(initial).toMatchObject({
      label: 'Minimize',
      icon: 'minimize-2',
      action: {
        kind: 'command',
        invocation: {
          command: 'view.setNodeCollapsed',
          params: { graphId: 'g0', nodeIds: ['n1', 'n2'], collapsed: true },
        },
      },
    })

    const minimized = docWith({
      view: { graphs: { g0: { nodes: { n1: { collapsed: true }, n2: { collapsed: true } } } } },
    })
    const restore = coreRegistry().resolve(ctx({ kind: 'node', nodeId: 'n1' }, { selection, doc: minimized }))
      .flatMap((group) => group.items)
      .find((item) => item.id === 'core.node.minimize')!
    expect(restore).toMatchObject({
      label: 'Restore',
      action: {
        kind: 'command',
        invocation: {
          command: 'view.setNodeCollapsed',
          params: { graphId: 'g0', nodeIds: ['n1', 'n2'], collapsed: false },
        },
      },
    })
  })

  it('offers explicit dynamic compaction only for selected nodes with persisted family members', () => {
    const base = docWith()
    const baseGraph = base.graphs.g0!
    const document = docWith({
      graphs: {
        ...base.graphs,
        g0: {
          ...baseGraph,
          nodes: {
            ...baseGraph.nodes,
            n1: { ...baseGraph.nodes.n1!, dynamic: { images: { members: ['m0'], seq: 1 } } },
            n2: {
              ...baseGraph.nodes.n2!,
              dynamic: { mode: { selected: 'batch' }, images: { memberState: { m4: {} }, seq: 5 } },
            },
          },
        },
      },
    })
    const selection = { nodes: ['n1', 'n2'], links: [], reroutes: [], valueSources: [], selectors: [] }
    const groups = coreRegistry().resolve(ctx({ kind: 'node', nodeId: 'n1' }, { doc: document, selection }))
    const compact = requireAction(groups.flatMap((group) => group.items)
      .find((entry) => entry.id === 'core.node.compactDynamic')!)
    expect(compact.label).toBe('Remove Unused Dynamic Inputs from 2 Nodes')
    expect(compact.action).toEqual({
      kind: 'command',
      invocation: {
        command: 'batch',
        params: {
          invocations: [
            { command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n1' } },
            { command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n2' } },
          ],
        },
      },
    })

    const withoutMembers = docWith({
      graphs: {
        ...base.graphs,
        g0: {
          ...baseGraph,
          nodes: {
            ...baseGraph.nodes,
            n1: {
              ...baseGraph.nodes.n1!,
              dynamic: { images: { seq: 1 }, mode: { selected: 'batch' } },
            },
          },
        },
      },
    })
    expect(coreRegistry().resolve(ctx({ kind: 'node', nodeId: 'n1' }, { doc: withoutMembers }))
      .flatMap((group) => group.items).some((entry) => entry.id === 'core.node.compactDynamic')).toBe(false)
  })

  it('node color offers the shared presets and Default for one node', () => {
    const groups = coreRegistry().resolve(ctx({ kind: 'node', nodeId: 'n1' }))
    const colors = menuDescendants(groups.flatMap((group) => group.items))
      .filter((item) => item.id.startsWith('core.node.color.'))
    expect(colors.map((item) => item.label)).toEqual([
      'Default',
      'Blue',
      'Green',
      'Red',
      'Yellow',
      'Purple',
    ])
    expect(colors[0]).toMatchObject({
      checked: true,
      action: {
        kind: 'command',
        invocation: { command: 'view.setNodeColor', params: { graphId: 'g0', nodeId: 'n1', color: null } },
      },
    })
    expect(colors[1]).toMatchObject({
      checked: false,
      action: {
        kind: 'command',
        invocation: { command: 'view.setNodeColor', params: { graphId: 'g0', nodeId: 'n1', color: '#355c7d' } },
      },
    })
  })

  it('node color batches every selected node when the target rides the selection', () => {
    const selection = { nodes: ['n1', 'n2'], links: [], reroutes: [], valueSources: [], selectors: [] }
    const groups = coreRegistry().resolve(ctx({ kind: 'node', nodeId: 'n1' }, { selection }))
    const blue = menuDescendants(groups.flatMap((group) => group.items))
      .find((item) => item.id === 'core.node.color.blue')!
    expect(requireAction(blue).action).toEqual({
      kind: 'command',
      invocation: {
        command: 'batch',
        params: {
          invocations: [
            { command: 'view.setNodeColor', params: { graphId: 'g0', nodeId: 'n1', color: '#355c7d' } },
            { command: 'view.setNodeColor', params: { graphId: 'g0', nodeId: 'n2', color: '#355c7d' } },
          ],
        },
      },
    })
  })

  it('open-subgraph appears only for subgraph instances', () => {
    const reg = coreRegistry()
    const plain = reg.resolve(ctx({ kind: 'node', nodeId: 'n1' }))
    expect(plain.some((g) => g.items.some((i) => i.id === 'core.node.openSubgraph'))).toBe(false)
    const sub = reg.resolve(ctx({ kind: 'node', nodeId: 's1' }))
    const nav = sub.find((g) => g.group === '10-nav')!
    expect(nav.items[0]).toMatchObject({
      id: 'core.node.openSubgraph',
      action: { kind: 'host', action: 'openSubgraph', params: { nodeId: 's1' } },
    })
  })

  it('offers node help only when the wire marker is present', () => {
    const reg = coreRegistry()
    const absent = reg.resolve(ctx({ kind: 'node', nodeId: 'n1' }))
    expect(absent.flatMap((group) => group.items).some((item) => item.id === 'core.node.help')).toBe(false)
    const available = reg.resolve(ctx({ kind: 'node', nodeId: 'n1' }, {
      nodeHasDocs: true,
      shortcuts: { 'node.help': 'F1' },
    }))
    expect(available.flatMap((group) => group.items).find((item) => item.id === 'core.node.help')).toMatchObject({
      label: 'Help', shortcut: 'F1',
      action: { kind: 'host', action: 'openNodeHelp', params: { nodeId: 'n1' } },
    })
  })

  it('reset-size appears only with a manual size override and clears via command', () => {
    const reg = coreRegistry()
    const sized = reg.resolve(ctx({ kind: 'node', nodeId: 'n1' }))
    const layout = sized.find((g) => g.group === '30-layout')!
    expect(layout.items.find((i) => i.id === 'core.node.resetSize')).toMatchObject({
      id: 'core.node.resetSize',
      action: {
        kind: 'command',
        invocation: { command: 'view.setNodeSize', params: { graphId: 'g0', nodeId: 'n1', size: null } },
      },
    })
    // n2 has no view size; no reset-size item anywhere.
    const unsized = reg.resolve(ctx({ kind: 'node', nodeId: 'n2' }))
    expect(unsized.some((g) => g.items.some((i) => i.id === 'core.node.resetSize'))).toBe(false)
  })

  it('node rename is always offered; Reset Name appears only for a real override', () => {
    const reg = coreRegistry()
    const plain = reg.resolve(ctx({ kind: 'node', nodeId: 'n1' }, { nodeDisplayName: 'K Sampler' }))
    expect(plain.flatMap((g) => g.items).find((i) => i.id === 'core.node.rename')).toMatchObject({
      label: 'Rename...',
      action: { kind: 'host', action: 'renameNode', params: { nodeId: 'n1' } },
    })
    expect(plain.some((g) => g.items.some((i) => i.id === 'core.node.resetName'))).toBe(false)

    const base = docWith()
    const renamedDoc = {
      ...base,
      graphs: {
        ...base.graphs,
        g0: { ...base.graphs.g0!, nodes: { ...base.graphs.g0!.nodes, n1: { ...base.graphs.g0!.nodes.n1!, title: 'Custom' } } },
      },
    }
    const renamed = reg.resolve(ctx(
      { kind: 'node', nodeId: 'n1' },
      { doc: renamedDoc, nodeDisplayName: 'K Sampler' },
    ))
    expect(renamed.flatMap((g) => g.items).find((i) => i.id === 'core.node.resetName')).toMatchObject({
      label: 'Reset Name',
      action: {
        kind: 'command',
        invocation: { command: 'node.setTitle', params: { graphId: 'g0', nodeId: 'n1', title: null } },
      },
    })

    const sameDoc = {
      ...renamedDoc,
      graphs: {
        ...renamedDoc.graphs,
        g0: { ...renamedDoc.graphs.g0, nodes: { ...renamedDoc.graphs.g0.nodes, n1: { ...renamedDoc.graphs.g0.nodes.n1!, title: 'K Sampler' } } },
      },
    }
    const same = reg.resolve(ctx(
      { kind: 'node', nodeId: 'n1' },
      { doc: sameDoc, nodeDisplayName: 'K Sampler' },
    ))
    expect(same.some((g) => g.items.some((i) => i.id === 'core.node.resetName'))).toBe(false)
  })

  it('group contributions: add at cursor, rename/color/delete on the group target', () => {
    const reg = coreRegistry()

    // Canvas offers Add Group with cursor-anchored bounds.
    const canvas = reg.resolve(ctx({ kind: 'canvas' }))
    const addGroup = canvas.flatMap((g) => g.items).find((i) => i.id === 'core.canvas.addGroup')!
    expect(addGroup.action).toMatchObject({
      kind: 'command',
      invocation: {
        command: 'view.createGroup',
        params: { graphId: 'g0', title: 'Group', bounds: { x: 10, y: 20, width: 320, height: 220 } },
      },
    })

    // Node target offers grouping the selection as a host action.
    const nodeMenu = reg.resolve(ctx({ kind: 'node', nodeId: 'n1' }, { selection: { nodes: ['n1', 'n2'], links: [], reroutes: [], valueSources: [], selectors: [] } }))
    const groupSel = nodeMenu.flatMap((g) => g.items).find((i) => i.id === 'core.node.groupSelection')!
    expect(groupSel.label).toBe('Group 2 Nodes')
    expect(groupSel.action).toEqual({ kind: 'host', action: 'groupSelection' })

    // Group target: rename (host), color presets (checked on current), delete.
    const doc = docWith({
      view: {
        graphs: {
          g0: {
            nodes: {},
            groups: {
              grp0: { id: 'grp0', title: 'Stage', bounds: { x: 0, y: 0, width: 100, height: 100 }, color: '#355c7d' },
            },
          },
        },
      },
    })
    const groupMenu = reg.resolve(ctx({ kind: 'group', groupId: 'grp0' }, { doc }))
    const items = menuDescendants(groupMenu.flatMap((g) => g.items))
    expect(items.find((i) => i.id === 'core.group.rename')!.action).toEqual({
      kind: 'host',
      action: 'renameGroup',
      params: { groupId: 'grp0' },
    })
    const blue = items.find((i) => i.id === 'core.group.color.blue')!
    expect(blue.checked).toBe(true)
    expect(blue.action).toMatchObject({
      kind: 'command',
      invocation: { command: 'view.setGroupColor', params: { graphId: 'g0', groupId: 'grp0', color: '#355c7d' } },
    })
    const def = items.find((i) => i.id === 'core.group.color.default')!
    expect(def.checked).toBe(false)
    expect(def.action).toMatchObject({
      invocation: { command: 'view.setGroupColor', params: { color: null } },
    })
    expect(items.find((i) => i.id === 'core.group.delete')!.action).toMatchObject({
      kind: 'command',
      invocation: { command: 'view.removeGroup', params: { graphId: 'g0', groupId: 'grp0' } },
    })

    // Unknown group id resolves to nothing.
    const ghost = reg.resolve(ctx({ kind: 'group', groupId: 'nope' }, { doc }))
    expect(ghost.flatMap((g) => g.items)).toEqual([])
  })

  it('link delete uses link.disconnect for ordinary links and net.disconnectInput for nets', () => {
    const reg = coreRegistry()
    const ordinary = reg.resolve(
      ctx({ kind: 'link', linkId: 'l4', to: { node: 'n2', port: 'model' } }),
    )
    expect(ordinary[0]!.items[0]!.action).toEqual({
      kind: 'command',
      invocation: { command: 'link.disconnect', params: { graphId: 'g0', linkId: 'l4' } },
    })
    const net = reg.resolve(
      ctx({ kind: 'link', linkId: 'net:t5:0', netId: 't5', to: { node: 'n2', port: 'ctx' } }),
    )
    expect(net[0]!.items[0]!.action).toEqual({
      kind: 'command',
      invocation: { command: 'net.disconnectInput', params: { graphId: 'g0', to: { node: 'n2', port: 'ctx' } } },
    })
  })

  it('canvas menu offers the palette; section menu toggles collapse', () => {
    const reg = coreRegistry()
    const canvas = reg.resolve(ctx({ kind: 'canvas' }))
    expect(canvas[0]!.items[0]).toMatchObject({ id: 'core.canvas.addNode', action: { kind: 'host', action: 'openPalette' } })
    expect(canvas.flatMap((group) => group.items)).toContainEqual(expect.objectContaining({
      id: 'core.canvas.createSubgraph',
      label: 'Create Empty Subgraph',
      action: { kind: 'host', action: 'createSubgraph' },
    }))
    expect(canvas.flatMap((group) => group.items)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'core.canvas.createMapRegion', action: { kind: 'host', action: 'createRegion', params: { kind: 'map' } } }),
      expect.objectContaining({ id: 'core.canvas.createFoldRegion', action: { kind: 'host', action: 'createRegion', params: { kind: 'fold' } } }),
      expect.objectContaining({ id: 'core.canvas.createWhileRegion', action: { kind: 'host', action: 'createRegion', params: { kind: 'while' } } }),
    ]))

    const collapsed = reg.resolve(ctx({ kind: 'section', nodeId: 'n1', sectionId: 'adv', collapsed: true }))
    expect(collapsed[0]!.items[0]).toMatchObject({
      label: 'Expand Section',
      action: {
        kind: 'command',
        invocation: {
          command: 'view.setSectionCollapsed',
          params: { graphId: 'g0', nodeId: 'n1', sectionId: 'adv', collapsed: false },
        },
      },
    })
    const open = reg.resolve(ctx({ kind: 'section', nodeId: 'n1', sectionId: 'adv', collapsed: false }))
    expect(open[0]!.items[0]!.label).toBe('Collapse Section')
  })

  it('queue-selection targets the node as a partial-execution host action', () => {
    const reg = coreRegistry()
    const groups = reg.resolve(ctx({ kind: 'node', nodeId: 'n1' }))
    const item = groups.flatMap((g) => g.items).find((i) => i.id === 'core.node.queueSelection')
    expect(item).toMatchObject({
      label: 'Execute up to Selection',
      action: { kind: 'host', action: 'queueSelection', params: { nodeIds: ['n1'] } },
    })
  })

  it('queue-selection rides the selection and drops unknown nodes', () => {
    const reg = coreRegistry()
    const groups = reg.resolve(
      ctx({ kind: 'node', nodeId: 'n1' }, { selection: { nodes: ['n1', 'n2', 'ghost'], links: [], reroutes: [], valueSources: [], selectors: [] } }),
    )
    const item = groups.flatMap((g) => g.items).find((i) => i.id === 'core.node.queueSelection')
    expect(item).toMatchObject({
      label: 'Execute up to Selection',
      action: { kind: 'host', action: 'queueSelection', params: { nodeIds: ['n1', 'n2'] } },
    })
  })

  it('queue-selection is root-graph only (subgraph occurrences are ambiguous)', () => {
    const reg = coreRegistry()
    const groups = reg.resolve(ctx({ kind: 'node', nodeId: 'n1' }, { graphId: 'sub1' }))
    expect(groups.flatMap((g) => g.items).find((i) => i.id === 'core.node.queueSelection')).toBeUndefined()
  })
})

describe('named net contributions', () => {
  // g0 carries one net 'ctx' (n1.out0 -> n2.ctx); sub1 carries its own net.
  function netDoc(collapsed = false): WorkflowDocument {
    return docWith({
      graphs: {
        g0: graph({
          id: 'g0',
          nodes: { n1: node('n1'), n2: node('n2'), n3: node('n3') },
          nets: {
            t5: {
              id: 't5' as never,
              name: 'ctx',
              source: { node: 'n1' as never, port: 'out0' as never },
              sinks: [{ node: 'n2' as never, port: 'ctx' as never }],
            },
          },
        }),
        sub1: graph({
          id: 'sub1',
          name: 'Sub',
          nodes: { m1: node('m1') },
          nets: {
            u7: {
              id: 'u7' as never,
              name: 'inner',
              source: { node: 'm1' as never, port: 'out0' as never },
              sinks: [],
            },
          },
        }),
      },
      view: { graphs: collapsed ? { g0: { nodes: {}, collapsedNets: ['t5'] } } : {} },
    })
  }

  it('hides every creation and management item when the capability is disabled', () => {
    const reg = coreRegistry()
    const options = { doc: netDoc(), features: { namedNets: false } }
    const targets = [
      { kind: 'pin', nodeId: 'n1', portId: 'out0', direction: 'out' },
      { kind: 'pin', nodeId: 'n2', portId: 'ctx', direction: 'in' },
      { kind: 'link', linkId: 'net:t5:0', netId: 't5', to: { node: 'n2', port: 'ctx' } },
      { kind: 'net', netId: 't5', role: 'sink', nodeId: 'n2', portId: 'ctx' },
    ] as const
    for (const target of targets) {
      const ids = reg.resolve(ctx(target, options)).flatMap((group) => group.items.map((item) => item.id))
      expect(ids.filter((id) => id.includes('Net') || id.startsWith('core.net.'))).toEqual([])
    }
  })

  it('output pins offer promote-to-net as a host action; input pins do not', () => {
    const reg = coreRegistry()
    const out = reg.resolve(ctx({ kind: 'pin', nodeId: 'n1', portId: 'out0', direction: 'out' }, { doc: netDoc() }))
    const promote = out.flatMap((g) => g.items).find((i) => i.id === 'core.pin.promoteToNet')
    expect(promote).toMatchObject({
      action: { kind: 'host', action: 'promoteToNet', params: { source: { node: 'n1', port: 'out0' } } },
    })
    const inn = reg.resolve(ctx({ kind: 'pin', nodeId: 'n2', portId: 'ctx', direction: 'in' }, { doc: netDoc() }))
    expect(inn.flatMap((g) => g.items).some((i) => i.id === 'core.pin.promoteToNet')).toBe(false)
  })

  it('input pins list only this graph definition\'s nets, checked when connected', () => {
    const reg = coreRegistry()
    const items = reg
      .resolve(ctx({ kind: 'pin', nodeId: 'n2', portId: 'ctx', direction: 'in' }, { doc: netDoc() }))
      .flatMap((g) => g.items)
      .filter((i) => i.id.startsWith('core.pin.connectToNet.'))
    // Exactly ONE net: g0's 'ctx'. sub1's 'inner' must not leak across the boundary.
    expect(items.map((i) => i.id)).toEqual(['core.pin.connectToNet.t5'])
    expect(items[0]).toMatchObject({ checked: true })
    // Connected input: the item disconnects instead of re-connecting.
    expect(items[0]!.action).toEqual({
      kind: 'command',
      invocation: { command: 'net.disconnectInput', params: { graphId: 'g0', to: { node: 'n2', port: 'ctx' } } },
    })
    // Unconnected input on another node: same net, connect action.
    const other = reg
      .resolve(ctx({ kind: 'pin', nodeId: 'n3', portId: 'ctx', direction: 'in' }, { doc: netDoc() }))
      .flatMap((g) => g.items)
      .find((i) => i.id === 'core.pin.connectToNet.t5')!
    expect(other.checked).toBe(false)
    expect(other.action).toEqual({
      kind: 'command',
      invocation: { command: 'net.connectInput', params: { graphId: 'g0', netId: 't5', to: { node: 'n3', port: 'ctx' } } },
    })
    // The net's own source node is never offered its own net (self-loop).
    const self = reg
      .resolve(ctx({ kind: 'pin', nodeId: 'n1', portId: 'in0', direction: 'in' }, { doc: netDoc() }))
      .flatMap((g) => g.items)
    expect(self.some((i) => i.id === 'core.pin.connectToNet.t5')).toBe(false)
  })

  it('net-derived noodles offer a display submenu/rename/delete; the current mode is checked', () => {
    const reg = coreRegistry()
    const target = { kind: 'link', linkId: 'net:t5:0', netId: 't5', to: { node: 'n2', port: 'ctx' } } as const
    const items = reg.resolve(ctx(target, { doc: netDoc() })).flatMap((g) => g.items)
    const display = items.find((i) => i.id === 'core.net.display')!
    expect(display.label).toBe("Display for 'ctx'")
    expect(display.children!.map((c) => c.id)).toEqual([
      'core.net.display.noodle',
      'core.net.display.tags',
      'core.net.display.guide',
    ])
    expect(display.children!.map((c) => c.checked)).toEqual([true, false, false])
    expect(display.children![1]!.action).toEqual({
      kind: 'command',
      invocation: { command: 'view.setNetDisplay', params: { graphId: 'g0', netId: 't5', mode: 'tags' } },
    })
    expect(items.find((i) => i.id === 'core.net.rename')).toMatchObject({
      action: { kind: 'host', action: 'renameNet', params: { netId: 't5' } },
    })
    expect(items.find((i) => i.id === 'core.net.delete')).toMatchObject({
      action: { kind: 'command', invocation: { command: 'net.remove', params: { graphId: 'g0', netId: 't5' } } },
    })

    const collapsedItems = reg
      .resolve(ctx({ kind: 'net', netId: 't5', role: 'source', nodeId: 'n1', portId: 'out0' }, { doc: netDoc(true) }))
      .flatMap((g) => g.items)
    const collapsedDisplay = collapsedItems.find((i) => i.id === 'core.net.display')!
    expect(collapsedDisplay.children!.map((c) => c.checked)).toEqual([false, true, false])
  })

  it('collapsed sink tags disconnect just their own sink; source tags cannot', () => {
    const reg = coreRegistry()
    const sink = reg
      .resolve(ctx({ kind: 'net', netId: 't5', role: 'sink', nodeId: 'n2', portId: 'ctx' }, { doc: netDoc(true) }))
      .flatMap((g) => g.items)
    expect(sink.find((i) => i.id === 'core.net.stubDisconnect')).toMatchObject({
      action: {
        kind: 'command',
        invocation: { command: 'net.disconnectInput', params: { graphId: 'g0', to: { node: 'n2', port: 'ctx' } } },
      },
    })
    const source = reg
      .resolve(ctx({ kind: 'net', netId: 't5', role: 'source', nodeId: 'n1', portId: 'out0' }, { doc: netDoc(true) }))
      .flatMap((g) => g.items)
    expect(source.some((i) => i.id === 'core.net.stubDisconnect')).toBe(false)
  })

  it('endpoint tags offer Reset Tag Position only while their placement is authored', () => {
    const reg = coreRegistry()
    const source = { kind: 'net', netId: 't5', role: 'source', nodeId: 'n1', portId: 'out0' } as const
    const sink = { kind: 'net', netId: 't5', role: 'sink', nodeId: 'n2', portId: 'ctx' } as const
    const items = (doc: WorkflowDocument, target: typeof source | typeof sink) =>
      reg.resolve(ctx(target, { doc })).flatMap((g) => g.items)

    // Default placement (no authored entries): nothing to reset.
    expect(items(netDoc(true), source).some((i) => i.id === 'core.net.stubResetPosition')).toBe(false)
    expect(items(netDoc(true), sink).some((i) => i.id === 'core.net.stubResetPosition')).toBe(false)

    // An authored sink entry offers the reset on that sink tag only.
    const authored: WorkflowDocument = {
      ...netDoc(true),
      ext: { 'dinkster.netViews': [
        { graphId: 'g0', netId: 't5', role: 'sink', to: { node: 'n2', port: 'ctx' }, offset: { x: 12, y: 34 } },
      ] },
    }
    expect(items(authored, source).some((i) => i.id === 'core.net.stubResetPosition')).toBe(false)
    expect(items(authored, sink).find((i) => i.id === 'core.net.stubResetPosition')).toMatchObject({
      label: 'Reset Tag Position',
      action: {
        kind: 'command',
        invocation: {
          command: 'net.resetView',
          params: { graphId: 'g0', netId: 't5', role: 'sink', to: { node: 'n2', port: 'ctx' } },
        },
      },
    })

    // An authored source entry addresses the source role without a PortRef.
    const authoredSource: WorkflowDocument = {
      ...netDoc(true),
      ext: { 'dinkster.netViews': [{ graphId: 'g0', netId: 't5', role: 'source', offset: { x: 5, y: 6 } }] },
    }
    expect(items(authoredSource, source).find((i) => i.id === 'core.net.stubResetPosition')).toMatchObject({
      action: {
        kind: 'command',
        invocation: { command: 'net.resetView', params: { graphId: 'g0', netId: 't5', role: 'source' } },
      },
    })

    // The capability gate hides the item even when authored.
    const gated = reg
      .resolve(ctx(sink, { doc: authored, features: { namedNets: false } }))
      .flatMap((g) => g.items)
    expect(gated.some((i) => i.id === 'core.net.stubResetPosition')).toBe(false)
  })
})

describe('value source contributions', () => {
  const vsDoc = (): WorkflowDocument =>
    docWith({
      graphs: {
        g0: graph({
          id: 'g0',
          nodes: { n1: node('n1') },
          valueSources: {
            v1: { id: asValueSourceId('v1'), value: 128 },
            v2: { id: asValueSourceId('v2'), value: 'hello' },
          },
        }),
      },
    })

  it('right-clicking a value source offers delete as the deleteSelection host action', () => {
    const reg = coreRegistry()
    const items = reg
      .resolve(ctx({ kind: 'valueSource', valueSourceId: 'v1' }, { doc: vsDoc() }))
      .flatMap((g) => g.items)
    expect(items.find((i) => i.id === 'core.valueSource.delete')).toMatchObject({
      label: 'Delete Value Source',
      action: { kind: 'host', action: 'deleteSelection' },
    })
  })

  it('delete rides the selection and drops unknown sources', () => {
    const reg = coreRegistry()
    const items = reg
      .resolve(
        ctx(
          { kind: 'valueSource', valueSourceId: 'v1' },
          { doc: vsDoc(), selection: { nodes: [], links: [], reroutes: [], valueSources: ['v1', 'v2', 'ghost'], selectors: [] } },
        ),
      )
      .flatMap((g) => g.items)
    expect(items.find((i) => i.id === 'core.valueSource.delete')!.label).toBe('Delete 2 Value Sources')
  })

  it('a target that is not in the document yields nothing', () => {
    const reg = coreRegistry()
    const groups = reg.resolve(ctx({ kind: 'valueSource', valueSourceId: 'nope' }, { doc: vsDoc() }))
    expect(groups.flatMap((g) => g.items).some((i) => i.id === 'core.valueSource.delete')).toBe(false)
  })

  it('canvas offers Add Value Source at the menu point, starting as a raw null', () => {
    const reg = coreRegistry()
    const items = reg.resolve(ctx({ kind: 'canvas' })).flatMap((g) => g.items)
    expect(items.find((i) => i.id === 'core.canvas.addValueSource')).toMatchObject({
      label: 'Add Value Source',
      action: {
        kind: 'command',
        invocation: { command: 'valueSource.add', params: { graphId: 'g0', position: { x: 10, y: 20 }, value: null } },
      },
    })
  })
})

describe('selector contributions', () => {
  const selDoc = (): WorkflowDocument =>
    docWith({
      graphs: {
        g0: graph({
          id: 'g0',
          nodes: { n1: node('n1') },
          selectors: {
            s1: {
              id: asSelectorId('s1'),
              candidates: [{ id: asSelectorCandidateId('c1') }, { id: asSelectorCandidateId('c2'), title: 'draft' }],
              policy: { kind: 'fixed', candidate: asSelectorCandidateId('c1') },
            },
            s2: {
              id: asSelectorId('s2'),
              candidates: [{ id: asSelectorCandidateId('c3') }],
              policy: { kind: 'random' },
            },
          },
        }),
      },
    })

  const selItems = (selectorId: string, extra?: Partial<MenuContext>) =>
    coreRegistry()
      .resolve(ctx({ kind: 'selector', selectorId }, { doc: selDoc(), ...extra }))
      .flatMap((g) => g.items)

  it('offers one choice per candidate plus random, current policy checked', () => {
    const items = selItems('s1')
    const fixed1 = items.find((i) => i.id === 'core.selector.policy.fixed.c1')
    const fixed2 = items.find((i) => i.id === 'core.selector.policy.fixed.c2')
    const random = items.find((i) => i.id === 'core.selector.policy.random')
    expect(fixed1).toMatchObject({
      label: 'Select: 1',
      checked: true,
      action: {
        kind: 'command',
        invocation: {
          command: 'selector.setPolicy',
          params: { graphId: 'g0', selectorId: 's1', policy: { kind: 'fixed', candidate: 'c1' } },
        },
      },
    })
    // Titled candidates label by title; untitled by 1-based ordinal.
    expect(fixed2).toMatchObject({ label: 'Select: draft', checked: false })
    expect(random).toMatchObject({
      label: 'Select: Random',
      checked: false,
      action: {
        kind: 'command',
        invocation: { command: 'selector.setPolicy', params: { graphId: 'g0', selectorId: 's1', policy: { kind: 'random' } } },
      },
    })
  })

  it('random policy is checked when active', () => {
    const items = selItems('s2')
    expect(items.find((i) => i.id === 'core.selector.policy.random')).toMatchObject({ checked: true })
  })

  it('offers Add Branch as a selector.addCandidate command', () => {
    const items = selItems('s1')
    expect(items.find((i) => i.id === 'core.selector.addCandidate')).toMatchObject({
      label: 'Add Branch',
      action: {
        kind: 'command',
        invocation: { command: 'selector.addCandidate', params: { graphId: 'g0', selectorId: 's1' } },
      },
    })
  })

  it('offers Remove Branch per candidate, but never for the last candidate', () => {
    const items = selItems('s1')
    expect(items.find((i) => i.id === 'core.selector.removeCandidate.c1')).toMatchObject({
      label: 'Remove Branch 1',
      action: {
        kind: 'command',
        invocation: {
          command: 'selector.removeCandidate',
          params: { graphId: 'g0', selectorId: 's1', candidateId: 'c1' },
        },
      },
    })
    expect(items.find((i) => i.id === 'core.selector.removeCandidate.c2')).toMatchObject({ label: 'Remove Branch draft' })
    // s2 has one candidate: no removal offered at all.
    const single = selItems('s2')
    expect(single.some((i) => i.id.startsWith('core.selector.removeCandidate'))).toBe(false)
  })

  it('offers rename as a host action carrying the selector id', () => {
    const items = selItems('s1')
    expect(items.find((i) => i.id === 'core.selector.rename')).toMatchObject({
      label: 'Rename Selector...',
      action: { kind: 'host', action: 'renameSelector', params: { selectorId: 's1' } },
    })
  })

  it('delete rides the selection and drops unknown selectors', () => {
    const alone = selItems('s1')
    expect(alone.find((i) => i.id === 'core.selector.delete')).toMatchObject({
      label: 'Delete Selector',
      action: { kind: 'host', action: 'deleteSelection' },
    })
    const riding = selItems('s1', {
      selection: { nodes: [], links: [], reroutes: [], valueSources: [], selectors: ['s1', 's2', 'ghost'] },
    })
    expect(riding.find((i) => i.id === 'core.selector.delete')!.label).toBe('Delete 2 Selectors')
  })

  it('a target that is not in the document yields nothing', () => {
    const groups = coreRegistry().resolve(ctx({ kind: 'selector', selectorId: 'nope' }, { doc: selDoc() }))
    expect(groups.flatMap((g) => g.items)).toHaveLength(0)
  })

  it('canvas offers Add Selector at the menu point', () => {
    const items = coreRegistry().resolve(ctx({ kind: 'canvas' })).flatMap((g) => g.items)
    expect(items.find((i) => i.id === 'core.canvas.addSelector')).toMatchObject({
      label: 'Add Selector',
      action: {
        kind: 'command',
        invocation: { command: 'selector.add', params: { graphId: 'g0', position: { x: 10, y: 20 } } },
      },
    })
  })
})
