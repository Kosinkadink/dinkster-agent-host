import { describe, expect, it } from 'vitest'
import { asConnectionId, compile, type DinksterGraphWire, type NodeSchema } from '@dinkster/core'
import { dynamicPromptInputsForArtifact, expandDynamicPromptsInGraph } from '../src/dinkster-connection.js'
import { expandDynamicPrompt } from '../src/dynamic-prompts.js'

describe('dynamic prompt expansion pinned to ComfyUI_frontend bdc0345d', () => {
  it.each([
    ['{a|b}', 0, 'a'],
    ['{a|b}', 0.99, 'b'],
    ['\\{a\\|b\\}', 0, '{a|b}'],
    ['{a|{b|{c|d}}}', 0.99, 'd'],
    ['/* before */x // after\ny', 0, 'x \ny'],
    ['{option1|option2|{nested1|nested2', 0.99, 'nested2'],
  ])('expands %s', (source, random, expected) => {
    expect(expandDynamicPrompt(source, () => random)).toBe(expected)
  })

  it('does not evaluate arbitrary template syntax', () => {
    expect(expandDynamicPrompt('${globalThis.alert(1)}', () => 0)).toBe('$globalThis.alert(1)')
  })

  it('expands only explicit true descriptors on a cloned submission graph', () => {
    const schema: NodeSchema = {
      type: 'Prompt', displayName: 'Prompt', category: 'test', source: 'v3', isOutputNode: true,
      items: [
        { kind: 'input', id: 'enabled', type: { kind: 'concrete', name: 'core.string' }, optional: false,
          widget: { widgetType: 'STRING', options: { dynamicPrompts: true } } },
        { kind: 'input', id: 'disabled', type: { kind: 'concrete', name: 'core.string' }, optional: false,
          widget: { widgetType: 'STRING', options: { dynamicPrompts: false } } },
        { kind: 'input', id: 'absent', type: { kind: 'concrete', name: 'core.string' }, optional: false,
          widget: { widgetType: 'STRING', options: {} } },
      ],
    }
    const graph: DinksterGraphWire = { nodes: { prompt: { nodeType: 'Prompt', inputs: {
      enabled: '{first|second}', disabled: '{keep|this}', absent: '{also|keep}',
    } } } }
    const expanded = expandDynamicPromptsInGraph(graph, (type) => type === 'Prompt' ? schema : undefined, () => 0)
    expect(expanded.nodes.prompt).toEqual({ nodeType: 'Prompt', inputs: {
      enabled: 'first', disabled: '{keep|this}', absent: '{also|keep}',
    } })
    expect(graph.nodes.prompt).toEqual({ nodeType: 'Prompt', inputs: {
      enabled: '{first|second}', disabled: '{keep|this}', absent: '{also|keep}',
    } })

    const nested: DinksterGraphWire = { nodes: { region: { region: {
      kind: 'map', ports: {}, inputs: { outer: '{left|right}' }, outputs: {},
      body: graph,
    } } } }
    const expandedNested = expandDynamicPromptsInGraph(
      nested,
      (type) => type === 'Prompt' ? schema : undefined,
      () => 0,
      new Set(['region\u0000outer', 'region.prompt\u0000enabled']),
    )
    expect((expandedNested.nodes.region as any).region.inputs.outer).toBe('left')
    expect((expandedNested.nodes.region as any).region.body.nodes.prompt.inputs.enabled).toBe('first')
    expect((nested.nodes.region as any).region.inputs.outer).toBe('{left|right}')
    expect((nested.nodes.region as any).region.body.nodes.prompt.inputs.enabled).toBe('{first|second}')
  })

  it('uses the representation selected in the compiled snapshot', () => {
    const enabled = { widgetType: 'STRING' as const, options: { dynamicPrompts: true } }
    const disabled = { widgetType: 'STRING' as const, options: { dynamicPrompts: false } }
    const schema: NodeSchema = {
      type: 'Prompt', displayName: 'Prompt', category: 'test', source: 'v3', isOutputNode: true,
      items: [{ kind: 'input', id: 'prompt', type: { kind: 'concrete', name: 'core.string' }, optional: false,
        widget: { ...enabled, representations: {
          default: 'enabled', userSwitchable: true,
          representations: [
            { id: 'enabled', displayName: 'Enabled', widget: enabled },
            { id: 'disabled', displayName: 'Disabled', widget: disabled },
          ],
        } } }],
    }
    const document = {
      format: 'dinkster-workflow' as const, formatVersion: 1 as const, lineage: 'dynamic-representation', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        prompt: { id: 'prompt', type: 'Prompt', values: { prompt: '{a|b}' } },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { prompt: { views: { prompt: 'disabled' } } } } } },
    } as any
    const result = compile({
      document, revision: 0, resolve: (type) => type === 'Prompt' ? schema : undefined,
      scope: { kind: 'full' }, connection: asConnectionId('test'), schemaHash: 'test',
    })
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
    const selected = dynamicPromptInputsForArtifact(result.artifact)
    expect(selected.has('prompt\u0000prompt')).toBe(false)
    const graph: DinksterGraphWire = { nodes: { prompt: { nodeType: 'Prompt', inputs: { prompt: '{a|b}' } } } }
    expect((expandDynamicPromptsInGraph(graph, () => schema, () => 0, selected).nodes.prompt as any).inputs.prompt)
      .toBe('{a|b}')
    document.view.graphs.g0.nodes.prompt.views.prompt = 'enabled'
    const enabledResult = compile({
      document, revision: 0, resolve: (type) => type === 'Prompt' ? schema : undefined,
      scope: { kind: 'full' }, connection: asConnectionId('test'), schemaHash: 'test',
    })
    if (!enabledResult.ok) throw new Error(JSON.stringify(enabledResult.diagnostics))
    const enabledInputs = dynamicPromptInputsForArtifact(enabledResult.artifact)
    expect((expandDynamicPromptsInGraph(graph, () => schema, () => 0, enabledInputs).nodes.prompt as any).inputs.prompt)
      .toBe('a')
  })
})
