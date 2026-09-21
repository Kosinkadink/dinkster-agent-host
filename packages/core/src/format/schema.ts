/**
 * JSON Schema (draft 2020-12) for the CURRENT workflow document format
 * (version 1, unstable until first release): the spec external tools
 * validate against (architecture section 16). Old versions load through the
 * migration chain in migrate.ts; this schema always describes the
 * post-migration shape.
 *
 * KEEP IN SYNC (enforced by test/format.schema.test.ts, which cross-checks
 * this schema against the hand-written runtime validator in validate.ts and
 * the golden workflow fixtures):
 * - src/format/document.ts (the TypeScript types)
 * - src/format/validate.ts (the dependency-free runtime validator)
 *
 * Forward-compatibility policy (additive-first): unknown properties are
 * ALLOWED everywhere. New optional fields must not break old validators;
 * breaking changes require a formatVersion bump + migration step.
 */

import { MAX_DYNAMIC_STATE_DEPTH } from './document.js'

const extData = { type: 'object' } as const

/**
 * Depth-bounded unrolling of the recursive dynamic-state shape. The runtime
 * validator enforces a hard nesting budget (MAX_DYNAMIC_STATE_DEPTH); JSON
 * Schema cannot count recursion depth through a self-referential $ref, so
 * the cap is expressed by chaining one $def per level. The deepest level
 * still allows empty memberState scaffolding (member entries with no
 * construct keys) - exactly what the runtime validator accepts.
 */
const dynamicPortStateLevel = (nested: unknown): Record<string, unknown> => ({
  type: 'object',
  properties: {
    members: { type: 'array', items: { type: 'string', minLength: 1 } },
    memberLabels: { type: 'object', additionalProperties: { type: 'string', minLength: 1 } },
    selected: { type: 'string' },
    seq: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
    memberState: {
      type: 'object',
      additionalProperties: { type: 'object', additionalProperties: nested },
    },
  },
})

const dynamicPortStateDefs = Object.fromEntries(
  Array.from({ length: MAX_DYNAMIC_STATE_DEPTH + 1 }, (_, level) => [
    level === 0 ? 'dynamicPortState' : `dynamicPortState${level}`,
    dynamicPortStateLevel(
      level < MAX_DYNAMIC_STATE_DEPTH ? { $ref: `#/$defs/dynamicPortState${level + 1}` } : false,
    ),
  ]),
)

const portRef = {
  type: 'object',
  required: ['node', 'port'],
  properties: {
    node: { type: 'string', minLength: 1 },
    port: { type: 'string', minLength: 1 },
    members: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
  },
} as const

const rerouteRef = {
  type: 'object',
  required: ['reroute'],
  properties: {
    reroute: { type: 'string', minLength: 1 },
  },
} as const

const valueSourceRef = {
  type: 'object',
  required: ['valueSource'],
  properties: {
    valueSource: { type: 'string', minLength: 1 },
  },
} as const

// {selector} = the selector's output; {selector, candidate} = one candidate input.
const selectorRef = {
  type: 'object',
  required: ['selector'],
  properties: {
    selector: { type: 'string', minLength: 1 },
    candidate: { type: 'string', minLength: 1 },
  },
} as const

const widgetTapRef = {
  type: 'object',
  required: ['node', 'tap'],
  properties: {
    node: { type: 'string', minLength: 1 },
    tap: { type: 'string', minLength: 1 },
  },
} as const

const boundaryBinding = {
  oneOf: [
    {
      type: 'object',
      required: ['kind', 'node', 'port'],
      properties: {
        kind: { enum: ['port', 'family', 'slot', 'dynamicCombo'] },
        node: { type: 'string', minLength: 1 },
        port: { type: 'string', minLength: 1 },
        members: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
        slots: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1, pattern: '^[^.]+(\\.[^.]+)*$' } },
      },
      not: { required: ['tap'] },
      if: {
        properties: { kind: { enum: ['port', 'slot', 'dynamicCombo'] } },
        required: ['kind'],
      },
      then: { not: { required: ['slots'] } },
    },
    {
      type: 'object',
      required: ['kind', 'node', 'tap'],
      properties: {
        kind: { const: 'widgetTap' },
        node: { type: 'string', minLength: 1 },
        tap: { type: 'string', minLength: 1 },
      },
      not: { anyOf: [{ required: ['port'] }, { required: ['members'] }, { required: ['slots'] }] },
    },
  ],
} as const

const boundaryItem = {
  type: 'object',
  required: ['id', 'binds'],
  properties: {
    id: { type: 'string', minLength: 1 },
    displayName: { type: 'string' },
    binds: { $ref: '#/$defs/boundaryBinding' },
    // Fan-out targets (input items only - the outputs array below forbids
    // it). Entries must match the primary binding kind; the runtime validator
    // also rejects duplicates.
    alsoBinds: { type: 'array', minItems: 1, items: { $ref: '#/$defs/boundaryBinding' } },
    promoted: { type: 'boolean' },
    ext: { $ref: '#/$defs/extData' },
  },
  allOf: [
    {
      if: {
        properties: { binds: { type: 'object', properties: { kind: { enum: ['widgetTap', 'slot', 'dynamicCombo'] } }, required: ['kind'] } },
        required: ['binds'],
      },
      then: {
        allOf: [
          { not: { required: ['alsoBinds'] } },
          { not: { required: ['promoted'] } },
        ],
      },
    },
    {
      if: {
        properties: { binds: { type: 'object', properties: { kind: { const: 'family' } }, required: ['kind'] } },
        required: ['binds'],
      },
      then: {
        allOf: [
          // The forwarded family template carries its widgets, so promotion
          // is invalid while homogeneous input family fan-out remains valid.
          { not: { required: ['promoted'] } },
          {
            properties: {
              alsoBinds: {
                items: {
                  $ref: '#/$defs/boundaryBinding',
                  properties: { kind: { const: 'family' } },
                  required: ['kind'],
                },
              },
            },
          },
        ],
      },
    },
    {
      if: {
        properties: { binds: { type: 'object', properties: { kind: { const: 'port' } }, required: ['kind'] } },
        required: ['binds'],
      },
      then: {
        properties: {
          alsoBinds: {
            items: {
              $ref: '#/$defs/boundaryBinding',
              properties: { kind: { const: 'port' } },
              required: ['kind'],
            },
          },
        },
      },
    },
  ],
} as const

export const WORKFLOW_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://dinkster.dev/schemas/workflow-v1.schema.json',
  title: 'Dinkster workflow document, format version 1',
  type: 'object',
  required: ['format', 'formatVersion', 'lineage', 'root', 'graphs', 'view'],
  properties: {
    format: { const: 'dinkster-workflow' },
    formatVersion: { const: 1 },
    lineage: { type: 'string', minLength: 1 },
    root: { type: 'string', minLength: 1 },
    graphs: {
      type: 'object',
      additionalProperties: { $ref: '#/$defs/graphDef' },
    },
    occurrenceTopologies: {
      type: 'object',
      additionalProperties: { $ref: '#/$defs/occurrenceTopology' },
    },
    surfaces: {
      type: 'object',
      additionalProperties: { $ref: '#/$defs/controlSurface' },
    },
    surfaceSeq: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
    view: { $ref: '#/$defs/viewState' },
    environment: { $ref: '#/$defs/environmentStamp' },
    meta: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        created: { type: 'string' },
        modified: { type: 'string' },
        ext: { $ref: '#/$defs/extData' },
      },
    },
    ext: { $ref: '#/$defs/extData' },
  },
  $defs: {
    environmentStamp: {
      type: 'object',
      description:
        'Producing-environment record, stamped from live /api/nodes at save. Advisory only: never identity, never load-bearing; malformed stamps are sanitized away with a warning at load.',
      required: ['packs', 'nodes'],
      properties: {
        dinkster: {
          type: 'object',
          required: ['version', 'schemaWire'],
          properties: {
            version: { type: 'string', minLength: 1 },
            schemaWire: { type: 'integer' },
          },
        },
        frontend: {
          type: 'object',
          required: ['version'],
          properties: { version: { type: 'string', minLength: 1 } },
        },
        packs: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            properties: {
              version: { type: 'string', minLength: 1 },
              artifactDigest: { type: 'string', minLength: 1 },
              source: { type: 'string', minLength: 1 },
              publisher: { type: 'string', minLength: 1 },
            },
          },
        },
        nodes: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            required: ['signature'],
            properties: {
              pack: { type: 'string', minLength: 1 },
              signature: { type: 'string', minLength: 1 },
            },
          },
        },
      },
    },
    extData,
    portRef,
    rerouteRef,
    valueSourceRef,
    selectorRef,
    widgetTapRef,
    // A link endpoint is a node port, a reroute junction, a value source, a
    // selector endpoint, or (source side only) a widget tap. anyOf (not
    // oneOf): unknown extra properties are allowed everywhere
    // (additive-first), so an endpoint carrying a foreign key must not
    // double-match. Widget taps PRODUCE, never consume - the target def
    // excludes them, mirroring the runtime validator.
    linkSource: {
      anyOf: [
        { $ref: '#/$defs/portRef' },
        { $ref: '#/$defs/rerouteRef' },
        { $ref: '#/$defs/valueSourceRef' },
        { $ref: '#/$defs/selectorRef' },
        { $ref: '#/$defs/widgetTapRef' },
      ],
    },
    linkTarget: {
      anyOf: [
        { $ref: '#/$defs/portRef' },
        { $ref: '#/$defs/rerouteRef' },
        { $ref: '#/$defs/valueSourceRef' },
        { $ref: '#/$defs/selectorRef' },
      ],
    },
    occurrenceRef: {
      type: 'object',
      required: ['instancePath', 'node'],
      properties: {
        instancePath: { type: 'array', items: { type: 'string', minLength: 1 } },
        node: { type: 'string', minLength: 1 },
      },
    },
    boundaryRouteLeg: {
      type: 'object',
      required: ['graph', 'boundaryId', 'binding'],
      properties: {
        graph: { type: 'string', minLength: 1 },
        boundaryId: { type: 'string', minLength: 1 },
        binding: { $ref: '#/$defs/boundaryBinding' },
      },
    },
    occurrenceBoundaryEndpoint: {
      type: 'object',
      required: ['kind', 'occurrence', 'address', 'route'],
      properties: {
        kind: { const: 'boundary' },
        occurrence: { $ref: '#/$defs/occurrenceRef' },
        address: {
          type: 'object',
          required: ['port'],
          properties: {
            port: { type: 'string', minLength: 1 },
            members: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
          },
        },
        route: {
          type: 'array',
          minItems: 1,
          items: { $ref: '#/$defs/boundaryRouteLeg' },
        },
      },
    },
    occurrenceLinkSource: {
      anyOf: [
        {
          type: 'object',
          required: ['kind', 'endpoint'],
          properties: { kind: { const: 'body' }, endpoint: { $ref: '#/$defs/linkSource' } },
        },
        { $ref: '#/$defs/occurrenceBoundaryEndpoint' },
      ],
    },
    occurrenceLinkTarget: {
      anyOf: [
        {
          type: 'object',
          required: ['kind', 'endpoint'],
          properties: { kind: { const: 'body' }, endpoint: { $ref: '#/$defs/linkTarget' } },
        },
        { $ref: '#/$defs/occurrenceBoundaryEndpoint' },
      ],
    },
    occurrenceLinkData: {
      type: 'object',
      required: ['id', 'from', 'to'],
      properties: {
        id: { type: 'string', minLength: 1 },
        from: { $ref: '#/$defs/occurrenceLinkSource' },
        to: { $ref: '#/$defs/occurrenceLinkTarget' },
        ext: { $ref: '#/$defs/extData' },
      },
    },
    parentDeliveryIdentity: {
      oneOf: [
        {
          type: 'object',
          required: ['kind', 'graph', 'linkId'],
          properties: {
            kind: { const: 'link' },
            graph: { type: 'string', minLength: 1 },
            linkId: { type: 'string', minLength: 1 },
          },
        },
        {
          type: 'object',
          required: ['kind', 'graph', 'netId', 'to'],
          properties: {
            kind: { const: 'netSink' },
            graph: { type: 'string', minLength: 1 },
            netId: { type: 'string', minLength: 1 },
            to: { $ref: '#/$defs/portRef' },
          },
        },
      ],
    },
    suppressedDelivery: {
      oneOf: [
        {
          type: 'object',
          required: ['kind', 'linkId'],
          properties: {
            kind: { const: 'link' },
            linkId: { type: 'string', minLength: 1 },
          },
        },
        {
          type: 'object',
          required: ['kind', 'netId', 'to'],
          properties: {
            kind: { const: 'netSink' },
            netId: { type: 'string', minLength: 1 },
            to: { $ref: '#/$defs/portRef' },
          },
        },
        {
          type: 'object',
          required: ['kind', 'delivery', 'route'],
          properties: {
            kind: { const: 'projectedLeg' },
            delivery: { $ref: '#/$defs/parentDeliveryIdentity' },
            route: {
              type: 'array',
              minItems: 1,
              items: { $ref: '#/$defs/boundaryRouteLeg' },
            },
          },
        },
      ],
    },
    occurrenceTopology: {
      type: 'object',
      required: ['owner', 'bodyGraph', 'links', 'nextOrdinal'],
      properties: {
        owner: { $ref: '#/$defs/occurrenceRef' },
        bodyGraph: { type: 'string', minLength: 1 },
        links: { type: 'object', additionalProperties: { $ref: '#/$defs/occurrenceLinkData' } },
        suppressedDeliveries: {
          type: 'array',
          minItems: 1,
          items: { $ref: '#/$defs/suppressedDelivery' },
        },
        nextOrdinal: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
        actorCursors: {
          type: 'object',
          propertyNames: { pattern: '^[A-Za-z0-9_-]+$', not: { const: '__proto__' } },
          additionalProperties: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
        },
        ext: { $ref: '#/$defs/extData' },
      },
    },
    boundaryBinding,
    boundaryItem,
    // Recursive: nested per-member dynamic state (memberState[memberId][construct])
    // is itself a dynamicPortState, unrolled to the shared hard depth cap.
    ...dynamicPortStateDefs,
    nodeData: {
      type: 'object',
      required: ['id', 'type', 'values'],
      properties: {
        id: { type: 'string', minLength: 1 },
        type: { type: 'string', minLength: 1 },
        virtual: { const: true },
        values: { type: 'object' },
        controllers: {
          type: 'object',
          additionalProperties: { enum: ['fixed', 'increment', 'decrement', 'randomize'] },
        },
        mode: { enum: ['active', 'muted', 'bypassed'] },
        dynamic: {
          type: 'object',
          additionalProperties: { $ref: '#/$defs/dynamicPortState' },
        },
        region: { $ref: '#/$defs/regionContract' },
        title: { type: 'string' },
        ext: { $ref: '#/$defs/extData' },
      },
    },
    regionContract: {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {
        kind: { enum: ['map', 'fold', 'while'] },
        elementPorts: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
        statePorts: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
        outputRoles: {
          type: 'object',
          propertyNames: { minLength: 1 },
          additionalProperties: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                required: ['kind'],
                properties: { kind: { const: 'gather' } },
              },
              {
                type: 'object',
                additionalProperties: false,
                required: ['kind'],
                properties: { kind: { const: 'flatten' } },
              },
              {
                type: 'object',
                additionalProperties: false,
                required: ['kind', 'statePort'],
                properties: {
                  kind: { const: 'state' },
                  statePort: { type: 'string', minLength: 1 },
                },
              },
            ],
          },
        },
        continueOutput: { type: 'string', minLength: 1 },
        binding: { enum: ['zip', 'cross', 'broadcast'] },
        maxIterations: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
      },
    },
    linkData: {
      type: 'object',
      required: ['id', 'from', 'to'],
      properties: {
        id: { type: 'string', minLength: 1 },
        from: { $ref: '#/$defs/linkSource' },
        to: { $ref: '#/$defs/linkTarget' },
        ext: { $ref: '#/$defs/extData' },
      },
    },
    rerouteData: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', minLength: 1 },
        ext: { $ref: '#/$defs/extData' },
      },
    },
    declaredSpec: {
      type: 'object',
      properties: {
        widgetType: { type: 'string', minLength: 1 },
        options: { type: 'object' },
        controller: { enum: ['after_generate', 'after_refresh'] },
      },
    },
    valueSourceData: {
      type: 'object',
      // 'value' must be PRESENT but may be any JSON value including null.
      required: ['id', 'value'],
      properties: {
        id: { type: 'string', minLength: 1 },
        value: true,
        spec: { $ref: '#/$defs/declaredSpec' },
        controller: { enum: ['fixed', 'increment', 'decrement', 'randomize'] },
        title: { type: 'string' },
        ext: { $ref: '#/$defs/extData' },
      },
    },
    selectorCandidateData: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', minLength: 1 },
        title: { type: 'string' },
      },
    },
    selectorPolicy: {
      type: 'object',
      required: ['kind'],
      properties: {
        kind: { enum: ['fixed', 'random'] },
        candidate: { type: 'string', minLength: 1 },
      },
      if: {
        properties: { kind: { const: 'fixed' } },
        required: ['kind'],
      },
      then: { required: ['candidate'] },
    },
    selectorData: {
      type: 'object',
      required: ['id', 'candidates', 'policy'],
      properties: {
        id: { type: 'string', minLength: 1 },
        candidates: { type: 'array', items: { $ref: '#/$defs/selectorCandidateData' } },
        policy: { $ref: '#/$defs/selectorPolicy' },
        title: { type: 'string' },
        ext: { $ref: '#/$defs/extData' },
      },
    },
    namedNetData: {
      type: 'object',
      required: ['id', 'name', 'source', 'sinks'],
      properties: {
        id: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1 },
        source: { $ref: '#/$defs/portRef' },
        sinks: { type: 'array', items: { $ref: '#/$defs/portRef' } },
        ext: { $ref: '#/$defs/extData' },
      },
    },
    graphDef: {
      type: 'object',
      required: ['id', 'name', 'nodes', 'links', 'nets', 'reroutes', 'nextOrdinal'],
      properties: {
        id: { type: 'string', minLength: 1 },
        name: { type: 'string' },
        nodes: { type: 'object', additionalProperties: { $ref: '#/$defs/nodeData' } },
        links: { type: 'object', additionalProperties: { $ref: '#/$defs/linkData' } },
        nets: { type: 'object', additionalProperties: { $ref: '#/$defs/namedNetData' } },
        reroutes: { type: 'object', additionalProperties: { $ref: '#/$defs/rerouteData' } },
        valueSources: { type: 'object', additionalProperties: { $ref: '#/$defs/valueSourceData' } },
        selectors: { type: 'object', additionalProperties: { $ref: '#/$defs/selectorData' } },
        boundary: {
          type: 'object',
          required: ['inputs', 'outputs'],
          properties: {
            inputs: {
              type: 'array',
              items: {
                allOf: [
                  { $ref: '#/$defs/boundaryItem' },
                  {
                    not: {
                      properties: {
                        binds: {
                          type: 'object',
                          properties: { kind: { const: 'widgetTap' } },
                          required: ['kind'],
                        },
                      },
                      required: ['binds'],
                    },
                  },
                ],
              },
            },
            // Fan-out is input-side only: an output has exactly one source.
            outputs: {
              type: 'array',
              items: {
                allOf: [
                  { $ref: '#/$defs/boundaryItem' },
                  { not: { required: ['alsoBinds'] } },
                  { properties: { binds: { properties: { kind: { enum: ['port', 'family', 'widgetTap'] } } } } },
                ],
              },
            },
          },
        },
        nextOrdinal: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
        actorCursors: {
          type: 'object',
          // Keys are actor ids embedded verbatim in allocated ids: safe id
          // alphabet only, '__proto__' excluded (mirrors isValidActorId /
          // validate.ts - it can never be an own plain-object key, so it
          // could never round-trip through this map).
          propertyNames: { pattern: '^[A-Za-z0-9_-]+$', not: { const: '__proto__' } },
          additionalProperties: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
        },
        ext: { $ref: '#/$defs/extData' },
      },
    },
    controlSurface: {
      type: 'object',
      required: ['id', 'type', 'config'],
      properties: {
        id: { type: 'string', minLength: 1 },
        type: { type: 'string', minLength: 1 },
        config: { type: 'object' },
        ext: { $ref: '#/$defs/extData' },
      },
    },
    vec2: {
      type: 'object',
      required: ['x', 'y'],
      properties: { x: { type: 'number' }, y: { type: 'number' } },
    },
    nodeViewState: {
      type: 'object',
      properties: {
        position: { $ref: '#/$defs/vec2' },
        size: {
          type: 'object',
          required: ['width', 'height'],
          properties: { width: { type: 'number' }, height: { type: 'number' } },
        },
        collapsed: { type: 'boolean' },
        views: { type: 'object', additionalProperties: { type: 'string' } },
        sections: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            required: ['collapsed'],
            properties: { collapsed: { type: 'boolean' } },
          },
        },
        color: { type: 'string' },
        ext: { $ref: '#/$defs/extData' },
      },
    },
    groupViewState: {
      type: 'object',
      required: ['id', 'title', 'bounds'],
      properties: {
        id: { type: 'string', minLength: 1 },
        title: { type: 'string' },
        bounds: {
          type: 'object',
          required: ['x', 'y', 'width', 'height'],
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
          },
        },
        color: { type: 'string' },
        ext: { $ref: '#/$defs/extData' },
      },
    },
    rerouteViewState: {
      type: 'object',
      required: ['position'],
      properties: {
        position: { $ref: '#/$defs/vec2' },
        ext: { $ref: '#/$defs/extData' },
      },
    },
    valueSourceViewState: {
      type: 'object',
      required: ['position'],
      properties: {
        position: { $ref: '#/$defs/vec2' },
        view: { type: 'string' },
        ext: { $ref: '#/$defs/extData' },
      },
    },
    selectorViewState: {
      type: 'object',
      required: ['position'],
      properties: {
        position: { $ref: '#/$defs/vec2' },
        ext: { $ref: '#/$defs/extData' },
      },
    },
    boundaryNodeViewState: {
      type: 'object',
      required: ['position'],
      properties: {
        position: { $ref: '#/$defs/vec2' },
        ext: { $ref: '#/$defs/extData' },
      },
    },
    graphViewState: {
      type: 'object',
      required: ['nodes'],
      properties: {
        nodes: { type: 'object', additionalProperties: { $ref: '#/$defs/nodeViewState' } },
        groups: { type: 'object', additionalProperties: { $ref: '#/$defs/groupViewState' } },
        groupSeq: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
        reroutes: { type: 'object', additionalProperties: { $ref: '#/$defs/rerouteViewState' } },
        valueSources: { type: 'object', additionalProperties: { $ref: '#/$defs/valueSourceViewState' } },
        selectors: { type: 'object', additionalProperties: { $ref: '#/$defs/selectorViewState' } },
        collapsedNets: { type: 'array', items: { type: 'string' } },
        guideNets: { type: 'array', items: { type: 'string' } },
        boundary: {
          type: 'object',
          properties: {
            inputs: { $ref: '#/$defs/boundaryNodeViewState' },
            outputs: { $ref: '#/$defs/boundaryNodeViewState' },
          },
          additionalProperties: false,
        },
        ext: { $ref: '#/$defs/extData' },
      },
    },
    viewState: {
      type: 'object',
      required: ['graphs'],
      properties: {
        graphs: { type: 'object', additionalProperties: { $ref: '#/$defs/graphViewState' } },
        surfaces: { type: 'object', additionalProperties: { type: 'object' } },
        bookmarks: { type: 'object', additionalProperties: { $ref: '#/$defs/viewBookmark' } },
        ext: { $ref: '#/$defs/extData' },
      },
    },
    viewBookmark: {
      type: 'object',
      required: ['graphStack', 'instancePath'],
      oneOf: [
        { required: ['view'], not: { required: ['viewport'] } },
        { required: ['viewport'], not: { required: ['view'] } },
      ],
      properties: {
        graphStack: { type: 'array', items: { type: 'string' }, minItems: 1 },
        instancePath: { type: 'array', items: { type: 'string' } },
        viewport: {
          type: 'object',
          required: ['x', 'y', 'scale'],
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            scale: { type: 'number', exclusiveMinimum: 0 },
          },
        },
        view: {
          type: 'object',
          required: ['x', 'y', 'width', 'height'],
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number', exclusiveMinimum: 0 },
            height: { type: 'number', exclusiveMinimum: 0 },
          },
        },
        ext: { $ref: '#/$defs/extData' },
      },
    },
  },
} as const
