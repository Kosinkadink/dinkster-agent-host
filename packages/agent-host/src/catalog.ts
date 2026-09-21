import { coreCommandRegistry } from '@dinkster/core'

export interface ParameterSchema {
  readonly type?: string
  readonly description?: string
  readonly required?: readonly string[]
  readonly properties?: Readonly<Record<string, ParameterSchema>>
  readonly items?: ParameterSchema
  readonly enum?: readonly (string | null)[]
  readonly oneOf?: readonly ParameterSchema[]
  readonly additionalProperties?: boolean | ParameterSchema
}

export interface CommandCatalogEntry {
  readonly id: string
  readonly summary: string
  readonly params: ParameterSchema
}

const string = (description?: string): ParameterSchema => ({ type: 'string', ...(description && { description }) })
const strings: ParameterSchema = { type: 'array', items: { type: 'string' } }
const vec2: ParameterSchema = {
  type: 'object',
  required: ['x', 'y'],
  properties: { x: { type: 'number' }, y: { type: 'number' } },
}
const json: ParameterSchema = { description: 'Any JSON value' }
const portRef: ParameterSchema = {
  type: 'object', required: ['node', 'port'],
  properties: { node: string(), port: string(), members: strings },
}
const endpoint: ParameterSchema = {
  description: 'A node port, reroute, value source, selector, or widget-tap endpoint',
  oneOf: [
    portRef,
    { type: 'object', required: ['reroute'], properties: { reroute: string() } },
    { type: 'object', required: ['valueSource'], properties: { valueSource: string() } },
    {
      type: 'object', required: ['selector'],
      properties: { selector: string(), candidate: string() },
    },
    {
      type: 'object', required: ['node', 'tap'],
      properties: { node: string(), tap: string() },
    },
  ],
}

const object = (
  required: readonly string[],
  properties: Readonly<Record<string, ParameterSchema>>,
): ParameterSchema => ({ type: 'object', required, properties })

const commandMetadata: readonly CommandCatalogEntry[] = [
  {
    id: 'node.add',
    summary: 'Add a node to a graph at a canvas position.',
    params: object(['graphId', 'type', 'position'], {
      graphId: string(), type: string(), position: vec2,
      values: { type: 'object', additionalProperties: json },
      dynamic: { type: 'object', additionalProperties: json },
      title: string(), region: { type: 'object' },
    }),
  },
  {
    id: 'node.remove',
    summary: 'Remove nodes and their dependent graph items.',
    params: object(['graphId', 'nodeIds'], { graphId: string(), nodeIds: strings }),
  },
  {
    id: 'node.move',
    summary: 'Set canvas positions for one or more nodes.',
    params: object(['graphId', 'positions'], {
      graphId: string(), positions: { type: 'object', additionalProperties: vec2 },
    }),
  },
  {
    id: 'node.setValue',
    summary: 'Set one stored node input value.',
    params: object(['graphId', 'nodeId', 'inputId', 'value'], {
      graphId: string(), nodeId: string(), inputId: string(), value: json,
    }),
  },
  {
    id: 'node.setValues',
    summary: 'Set multiple stored node input values atomically.',
    params: object(['graphId', 'nodeId', 'values'], {
      graphId: string(), nodeId: string(), values: { type: 'object', additionalProperties: json },
    }),
  },
  {
    id: 'node.setTitle',
    summary: 'Set a node title, or clear it with null.',
    params: object(['graphId', 'nodeId', 'title'], {
      graphId: string(), nodeId: string(), title: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    }),
  },
  {
    id: 'node.setMode',
    summary: 'Set the execution mode for one or more nodes.',
    params: object(['graphId', 'nodeIds', 'mode'], {
      graphId: string(), nodeIds: strings, mode: { type: 'string', enum: ['active', 'muted', 'bypassed'] },
    }),
  },
  {
    id: 'link.connect',
    summary: 'Connect two graph endpoints, replacing an existing target driver.',
    params: object(['graphId', 'from', 'to'], { graphId: string(), from: endpoint, to: endpoint }),
  },
  {
    id: 'link.rewire',
    summary: 'Move an existing link to a new target endpoint.',
    params: object(['graphId', 'linkId', 'to'], { graphId: string(), linkId: string(), to: endpoint }),
  },
  {
    id: 'graph.deleteItems',
    summary: 'Delete a mixed selection of graph items atomically.',
    params: object(['graphId'], {
      graphId: string(), nodeIds: strings, linkIds: strings,
      netSinks: { type: 'array', items: portRef }, rerouteIds: strings,
      valueSourceIds: strings, selectorIds: strings,
    }),
  },
  {
    id: 'batch',
    summary: 'Run a non-empty list of non-batch commands atomically.',
    params: object(['invocations'], {
      invocations: {
        type: 'array',
        items: object(['command', 'params'], { command: string(), params: json }),
      },
    }),
  },
]

export const commandCatalog: readonly CommandCatalogEntry[] = [...coreCommandRegistry().keys()].map((id) =>
  commandMetadata.find((entry) => entry.id === id) ?? {
    id,
    summary: `Registered command: ${id}. Parameters are validated by the command.`,
    params: { description: 'Command-specific JSON parameters; no schema metadata registered.' },
  },
)
