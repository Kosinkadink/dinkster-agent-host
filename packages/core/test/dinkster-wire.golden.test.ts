/**
 * Native Dinkster schema wire decoder against a GOLDEN payload emitted by the
 * real backend encoder (dinkster_schema.schema_to_wire at its recorded schema
 * version - regenerate with the script referenced in fixtures/dinkster-nodes.json's
 * provenance: every TypeExpr kind, families both sides, defaults, onAbsent,
 * optional outputs, admission hints).
 *
 * Contract: this is a boundary normalizer into the ONE internal NodeSchema -
 * nothing downstream branches on which decoder produced a schema, so what we
 * assert here is the normalized model, not wire echoes.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DINKSTER_SCHEMA_WIRE_VERSION,
  parseDinksterNodes,
  typeExprFromDinksterWire,
  effectiveAbsentPolicy,
  inputsOf,
  outputsOf,
  searchVisibilityOf,
  type DinksterNodesPayload,
  type InputSpec,
  type TypeExpr,
} from '../src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const rawPayload = JSON.parse(readFileSync(join(here, '../fixtures/dinkster-nodes.json'), 'utf8')) as DinksterNodesPayload
const payload = {
  ...rawPayload,
  nodes: Object.fromEntries(Object.entries(rawPayload.nodes as Record<string, Record<string, unknown>>).map(([type, node]) => [
    type,
    { ...node, ...(type === 'test.primitives' ? { searchTerms: ['PrimitiveNode'] } : {}) },
  ])),
} satisfies DinksterNodesPayload
const PREDECESSOR_WIDGET_WIRE_VERSION = 16

const { schemas, diagnostics } = parseDinksterNodes(payload)
const schema = (type: string) => {
  const s = schemas.get(type)
  expect(s, `schema '${type}'`).toBeDefined()
  return s!
}
const input = (type: string, id: string): InputSpec => {
  const spec = inputsOf(schema(type)).find((i) => i.id === id)
  expect(spec, `${type}.${id}`).toBeDefined()
  return spec!
}

describe('parseDinksterNodes golden payload', () => {
  it('decodes every node with no diagnostics', () => {
    expect(diagnostics).toEqual([])
    expect([...schemas.keys()].sort()).toEqual([
      'std.math.add_ints',
      'test.absence',
      'test.families',
      'test.hints',
      'test.primitives',
      'test.types',
    ])
  })

  it('identity fields normalize; admission hints ride ext without editor meaning', () => {
    const s = schema('test.primitives')
    expect(s.displayName).toBe('Primitives')
    expect(s.category).toBe('test')
    expect(s.description).toBe('every widget-derivable primitive')
    expect(s.searchTerms).toEqual(['PrimitiveNode'])
    expect(schema('test.types').searchTerms).toEqual([])
    expect(s.source).toBe('v3')
    const hints = schema('test.hints').ext?.['dinkster'] as Record<string, unknown>
    expect(hints['occupies']).toEqual(['gpu'])
    expect(hints['version']).toBe(1)
  })

  it('interface order is preserved as declared', () => {
    expect(schema('test.primitives').items.map((i) => i.id)).toEqual([
      'count',
      'scale',
      'label',
      'enabled',
      'image',
      'out',
    ])
  })

  it('retains an input and output that share the same id', () => {
    const result = parseDinksterNodes({
      schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION,
      nodes: {
        'comfy.SaveAudioAdvanced': {
          schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION,
          interface: [
            { role: 'input', id: 'audio', required: true, type: { kind: 'concrete', types: ['comfy.AUDIO'] } },
            { role: 'output', id: 'audio', type: { kind: 'concrete', types: ['comfy.AUDIO'] } },
          ],
        },
      },
    })

    expect(result.diagnostics).toEqual([])
    const passthrough = result.schemas.get('comfy.SaveAudioAdvanced')
    expect(passthrough).toBeDefined()
    if (passthrough === undefined) throw new Error('expected SaveAudioAdvanced schema')
    expect(passthrough.items.map((item) => [item.kind, item.id])).toEqual([
      ['input', 'audio'],
      ['output', 'audio'],
    ])
    expect(inputsOf(passthrough).map((item) => item.id)).toEqual(['audio'])
    expect(outputsOf(passthrough).map((item) => item.id)).toEqual(['audio'])
  })

  it('core primitives become widget-backed with their wire defaults; others stay sockets', () => {
    expect(input('test.primitives', 'count').widget).toEqual({ widgetType: 'INT', options: {}, default: 4 })
    expect(input('test.primitives', 'scale').widget).toEqual({ widgetType: 'FLOAT', options: {}, default: 0.5 })
    expect(input('test.primitives', 'label').widget).toEqual({ widgetType: 'STRING', options: {}, default: 'hi' })
    expect(input('test.primitives', 'enabled').widget).toEqual({ widgetType: 'BOOLEAN', options: {}, default: true })
    const image = input('test.primitives', 'image')
    expect(image.widget).toBeUndefined()
    expect(image.optional).toBe(true)
    expect(input('test.primitives', 'count').tooltip).toBe('how many')
  })

  it('absence: onAbsent survives, defaults stay derivable, optional outputs mark', () => {
    expect(input('test.absence', 'must').onAbsent).toBe('fail')
    expect(input('test.absence', 'tolerant').onAbsent).toBe('accept')
    const maybe = input('test.absence', 'maybe')
    expect(maybe.onAbsent).toBeUndefined()
    expect(effectiveAbsentPolicy(maybe)).toBe('omit')
    expect(effectiveAbsentPolicy(input('test.absence', 'must'))).toBe('fail')
    const outs = outputsOf(schema('test.absence'))
    expect(outs.find((o) => o.id === 'image')!.optional).toBeUndefined()
    const mask = outs.find((o) => o.id === 'mask')!
    expect(mask.optional).toBe(true)
    expect(mask.tooltip).toBe('present when detected')
  })

  it('every TypeExpr kind decodes structurally', () => {
    const t = (id: string): TypeExpr => input('test.types', id).type
    expect(t('either')).toEqual({ kind: 'union', names: ['core.int', 'core.float'] })
    expect(t('anything')).toEqual({ kind: 'wildcard' })
    expect(t('t_in')).toEqual({ kind: 'variable', templateId: 'T' })
    expect(t('c_in')).toEqual({
      kind: 'variable',
      templateId: 'C',
      allowedTypes: [
        { kind: 'concrete', name: 'core.int' },
        { kind: 'concrete', name: 'core.float' },
      ],
    })
    expect(t('ints')).toEqual({ kind: 'list', element: { kind: 'concrete', name: 'core.int' } })
    expect(t('matrix')).toEqual({
      kind: 'list',
      element: { kind: 'list', element: { kind: 'concrete', name: 'core.int' } },
    })
    // Element polymorphism: the variable is shared with t_in/t_out.
    expect(t('items')).toEqual({ kind: 'list', element: { kind: 'variable', templateId: 'T' } })
    expect(outputsOf(schema('test.types'))[0]!.type).toEqual({ kind: 'variable', templateId: 'T' })
  })

  it('families become autogrow specs on both sides, bounds carried', () => {
    const operands = input('test.families', 'operands')
    expect(operands.dynamic).toEqual({
      kind: 'autogrow',
      template: [{ kind: 'input', id: 'operands', type: { kind: 'concrete', name: 'core.int' }, optional: false }],
      naming: { kind: 'prefix', prefix: 'operands', min: 2, max: 8 },
    })
    // Unbounded on the wire -> no max here; the editor growth cap applies.
    const extras = input('test.families', 'extras')
    expect(extras.dynamic).toMatchObject({ naming: { kind: 'prefix', prefix: 'extras' } })
    expect((extras.dynamic as { naming: { max?: number } }).naming.max).toBeUndefined()
    const parts = outputsOf(schema('test.families')).find((o) => o.id === 'parts')!
    expect(parts.dynamic).toMatchObject({ kind: 'autogrow', naming: { kind: 'prefix', prefix: 'parts', min: 1, max: 4 } })
  })

  it('isOutputNode derives from idempotence (explicit-target hint, nothing more)', () => {
    expect(schema('test.types').isOutputNode).toBe(true) // idempotent: false
    expect(schema('std.math.add_ints').isOutputNode).toBe(false)
  })
})

describe('strictness at the boundary', () => {
  it('refuses stale v7, v8, and v9 payloads loudly (one current version at a time)', () => {
    for (const stale of [7, 8, 9]) {
      const r = parseDinksterNodes({ schemaVersion: stale, nodes: {} })
      expect(r.schemas.size).toBe(0)
      expect(r.diagnostics.map((d) => d.code)).toEqual(['schema.dinkster.wireVersion'])
    }
  })
  it('a wrong schemaVersion yields one loud error and zero schemas', () => {
    const r = parseDinksterNodes({ schemaVersion: 2, nodes: {} })
    expect(r.schemas.size).toBe(0)
    expect(r.diagnostics).toHaveLength(1)
    expect(r.diagnostics[0]!.code).toBe('schema.dinkster.wireVersion')
    expect(r.diagnostics[0]!.message).toContain(`${DINKSTER_SCHEMA_WIRE_VERSION}`)
  })

  it('reads the wire version from dinkster.schemaWire: live backends put the API surface version top-level', () => {
    // Live /api/nodes shape since backend editing implementation: top-level schemaVersion is the
    // API surface version (1); the schema wire version rides dinkster.schemaWire
    // and each node entry. The header must win over the top-level field.
    const wireNode = {
      schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION,
      nodeType: 'std.util.identity',
      displayName: 'Identity',
      idempotent: true,
      interface: [],
    }
    const live = parseDinksterNodes({
      schemaVersion: 1,
      epoch: 1,
      dinkster: { version: '0.0.1', schemaWire: DINKSTER_SCHEMA_WIRE_VERSION },
      nodes: { 'std.util.identity': wireNode },
    })
    expect(live.diagnostics.filter((d) => d.code === 'schema.dinkster.wireVersion')).toHaveLength(0)
    expect(live.schemas.size).toBe(1)
    // A header advertising an unsupported wire version is rejected loudly.
    const future = parseDinksterNodes({
      schemaVersion: 1,
      dinkster: { version: '0.0.1', schemaWire: DINKSTER_SCHEMA_WIRE_VERSION + 1 },
      nodes: {},
    })
    expect(future.schemas.size).toBe(0)
    expect(future.diagnostics[0]!.code).toBe('schema.dinkster.wireVersion')
  })

  it('decodes v4 ASSET presentation and retains primitive fallback', () => {
    const r = parseDinksterNodes({
      schemaVersion: 4,
      nodes: {
        'comfy.LoadImage': {
          schemaVersion: 4,
          interface: [
            {
              role: 'input',
              id: 'asset',
              required: true,
              type: { kind: 'concrete', types: ['dinkster.asset'] },
              widget: { type: 'ASSET', accept: ['image/png', 'image/jpeg', 'image/webp'] },
            },
            { role: 'input', id: 'label', required: true, type: { kind: 'concrete', types: ['core.string'] } },
          ],
        },
      },
    })
    expect(r.diagnostics).toEqual([])
    expect(inputsOf(r.schemas.get('comfy.LoadImage')!)[0]!.widget).toEqual({
      widgetType: 'ASSET',
      options: { accept: ['image/png', 'image/jpeg', 'image/webp'] },
    })
    expect(inputsOf(r.schemas.get('comfy.LoadImage')!)[1]!.widget).toEqual({ widgetType: 'STRING', options: {} })
  })

  it('decodes v5 SAVE_TARGET presentation; the omitted-when-empty suffix normalizes to one shape', () => {
    const dflt = { mount: 'comfy-output', prefix: 'ComfyUI' }
    const r = parseDinksterNodes({
      schemaVersion: 5,
      nodes: {
        'comfy.SaveImage': {
          schemaVersion: 5,
          interface: [
            {
              role: 'input',
              id: 'target',
              required: false,
              default: dflt,
              type: { kind: 'concrete', types: ['dinkster.save_target'] },
              widget: { type: 'SAVE_TARGET', suffix: '.png' },
            },
            {
              role: 'input',
              id: 'bare',
              required: false,
              type: { kind: 'concrete', types: ['dinkster.save_target'] },
              // The wire omits suffix when empty; consumers must still read
              // ONE options shape.
              widget: { type: 'SAVE_TARGET' },
            },
          ],
        },
      },
    })
    expect(r.diagnostics).toEqual([])
    const inputs = inputsOf(r.schemas.get('comfy.SaveImage')!)
    expect(inputs[0]!.widget).toEqual({
      widgetType: 'SAVE_TARGET',
      options: { suffix: '.png' },
      default: dflt,
    })
    expect(inputs[1]!.widget).toEqual({ widgetType: 'SAVE_TARGET', options: { suffix: '' } })
  })

  it('v4 payloads remain accepted after the v5 bump (additive contract)', () => {
    const r = parseDinksterNodes({
      schemaVersion: 4,
      nodes: {
        'std.util.identity': {
          schemaVersion: 4,
          interface: [{ role: 'input', id: 'x', required: true, type: { kind: 'concrete', types: ['core.string'] } }],
        },
      },
    })
    expect(r.diagnostics).toEqual([])
    expect(r.schemas.size).toBe(1)
  })

  it('a malformed SAVE_TARGET descriptor (non-string suffix) falls back without hiding the input', () => {
    const r = parseDinksterNodes({
      schemaVersion: 5,
      nodes: {
        bad: {
          schemaVersion: 5,
          interface: [
            {
              role: 'input',
              id: 'target',
              required: false,
              type: { kind: 'concrete', types: ['dinkster.save_target'] },
              widget: { type: 'SAVE_TARGET', suffix: 7 },
            },
          ],
        },
      },
    })
    // Unknown/malformed descriptors keep the decoder's tolerance policy: the
    // input survives (no widget, non-primitive type), the node still loads.
    expect(r.schemas.size).toBe(1)
    expect(inputsOf(r.schemas.get('bad')!)[0]!.widget).toBeUndefined()
  })

  it('a node entry with a mismatched wire version fails alone', () => {
    const good = {
      schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION,
      nodeType: 'std.util.good',
      displayName: 'Good',
      idempotent: true,
      interface: [],
    }
    const stale = { ...good, nodeType: 'std.util.stale', schemaVersion: 14 }
    const r = parseDinksterNodes({
      schemaVersion: 1,
      dinkster: { version: '0.1.0', schemaWire: DINKSTER_SCHEMA_WIRE_VERSION },
      nodes: { 'std.util.good': good, 'std.util.stale': stale },
    })
    expect(r.schemas.has('std.util.good')).toBe(true)
    expect(r.schemas.has('std.util.stale')).toBe(false)
    expect(r.diagnostics.some((d) => d.code === 'schema.dinkster.wireVersion' && d.message.includes('std.util.stale'))).toBe(true)
  })

  it('an unknown TypeExpr kind fails that node, not the payload', () => {
    const r = parseDinksterNodes({
      schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION,
      nodes: {
        bad: { interface: [{ role: 'input', id: 'x', type: { kind: 'tuple' }, required: true }] },
        good: { displayName: 'ok', interface: [] },
      },
    })
    expect(r.schemas.has('bad')).toBe(false)
    expect(r.schemas.has('good')).toBe(true)
    expect(r.diagnostics.some((d) => d.code === 'schema.parse.threw' && d.message.includes('tuple'))).toBe(true)
  })

  it('malformed concrete/union/variable shapes are rejected', () => {
    expect(() => typeExprFromDinksterWire({ kind: 'concrete', types: [] })).toThrow(/exactly 1/)
    expect(() => typeExprFromDinksterWire({ kind: 'union', types: ['one'] })).toThrow(/at least two/)
    expect(() => typeExprFromDinksterWire({ kind: 'variable' })).toThrow(/templateId/)
    expect(() => typeExprFromDinksterWire({ kind: 'list' })).toThrow()
  })

  it("required + onAbsent='omit' is dropped to the default with a warning", () => {
    const r = parseDinksterNodes({
      schemaVersion: 14,
      nodes: {
        n: {
          schemaVersion: 14,
          interface: [
            { role: 'input', id: 'x', type: { kind: 'concrete', types: ['core.int'] }, required: true, onAbsent: 'omit' },
          ],
        },
      },
    })
    const spec = inputsOf(r.schemas.get('n')!)[0]!
    expect(spec.onAbsent).toBeUndefined()
    expect(effectiveAbsentPolicy(spec)).toBe('skip')
    expect(r.diagnostics.some((d) => d.code === 'schema.dinkster.badAbsentPolicy')).toBe(true)
  })

  it('an unknown interface role is skipped with a warning; the node survives', () => {
    const r = parseDinksterNodes({
      schemaVersion: 14,
      nodes: {
        n: {
          schemaVersion: 14,
          interface: [
            { role: 'region', id: 'r', type: { kind: 'wildcard' } },
            { role: 'output', id: 'out', type: { kind: 'concrete', types: ['core.int'] } },
          ],
        },
      },
    })
    expect(r.schemas.get('n')!.items.map((i) => i.id)).toEqual(['out'])
    expect(r.diagnostics.some((d) => d.code === 'schema.dinkster.unknownRole')).toBe(true)
  })
})

describe('ASSET kind presentation metadata (predecessor wire 16)', () => {
  const decode = (widget: Record<string, unknown>) => parseDinksterNodes({
    schemaVersion: PREDECESSOR_WIDGET_WIRE_VERSION,
    nodes: {
      'test.asset': {
        schemaVersion: PREDECESSOR_WIDGET_WIRE_VERSION,
        interface: [{
          role: 'input',
          id: 'asset',
          type: { kind: 'concrete', types: ['core.asset'] },
          widget,
        }],
      },
    },
  })

  it('preserves an open-vocabulary kind and permits it to be omitted', () => {
    const withKind = decode({ type: 'ASSET', accept: ['image/*'], kind: 'model/lora' })
    expect(inputsOf(withKind.schemas.get('test.asset')!)[0]!.widget).toEqual({
      widgetType: 'ASSET', options: { accept: ['image/*'] }, kind: 'model/lora',
    })
    const withoutKind = decode({ type: 'ASSET', accept: ['image/*'] })
    expect(inputsOf(withoutKind.schemas.get('test.asset')!)[0]!.widget).toEqual({
      widgetType: 'ASSET', options: { accept: ['image/*'] },
    })
  })

  it('warns and drops a malformed kind without rejecting the schema or widget', () => {
    const result = decode({ type: 'ASSET', accept: ['*/*'], kind: 'Model/Lora' })
    expect(result.diagnostics.map((d) => d.code)).toEqual(['schema.dinkster.badAssetKind'])
    expect(inputsOf(result.schemas.get('test.asset')!)[0]!.widget).toEqual({
      widgetType: 'ASSET', options: { accept: ['*/*'] },
    })
  })
})

describe('COMBO widget descriptor (wire v14)', () => {
  const decode = (widget: Record<string, unknown>, socket = 'core.combo') => parseDinksterNodes({
    schemaVersion: PREDECESSOR_WIDGET_WIRE_VERSION,
    nodes: {
      'test.combo': {
        schemaVersion: PREDECESSOR_WIDGET_WIRE_VERSION,
        interface: [{
          role: 'input',
          id: 'sampler_name',
          type: { kind: 'concrete', types: [socket] },
          default: 'euler',
          widget,
        }],
      },
    },
  })
  const widgetOf = (r: ReturnType<typeof parseDinksterNodes>) => inputsOf(r.schemas.get('test.combo')!)[0]!.widget

  it('drops a COMBO descriptor from a non-core.combo socket', () => {
    const r = decode({ type: 'COMBO', options: ['euler'] }, 'core.string')
    expect(r.diagnostics.map((d) => d.code)).toEqual(['schema.dinkster.badComboSocket'])
    const input = inputsOf(r.schemas.get('test.combo')!)[0]!
    expect(input.type).toEqual({ kind: 'concrete', name: 'core.string' })
    expect(input.widget).toBeUndefined()
  })

  it('static options decode into the COMBO spec', () => {
    const r = decode({ type: 'COMBO', options: ['euler', 'dpmpp_2m'] })
    expect(r.diagnostics).toHaveLength(0)
    expect(widgetOf(r)).toEqual({
      widgetType: 'COMBO', options: { options: ['euler', 'dpmpp_2m'] }, default: 'euler',
    })
  })

  it('a remote source decodes with its route and refreshButton; false is omitted', () => {
    const r = decode({ type: 'COMBO', options: ['euler'], remote: { route: '/api/choices/comfy.samplers', refreshButton: true } })
    expect(widgetOf(r)).toEqual({
      widgetType: 'COMBO',
      options: { options: ['euler'] },
      remote: { route: '/api/choices/comfy.samplers', refreshButton: true },
      default: 'euler',
    })
    const noButton = decode({ type: 'COMBO', remote: { route: '/api/choices/x' } })
    expect(widgetOf(noButton)).toEqual({
      widgetType: 'COMBO', options: {}, remote: { route: '/api/choices/x' }, default: 'euler',
    })
  })

  it('malformed options drop with a warning; a valid remote keeps the combo', () => {
    const r = decode({ type: 'COMBO', options: ['ok', 7], remote: { route: '/api/choices/x' } })
    expect(r.diagnostics.map((d) => d.code)).toEqual(['schema.dinkster.badComboOptions'])
    expect(widgetOf(r)).toEqual({
      widgetType: 'COMBO', options: {}, remote: { route: '/api/choices/x' }, default: 'euler',
    })
  })

  it('a malformed remote drops with a warning; static options keep the combo', () => {
    const r = decode({ type: 'COMBO', options: ['euler'], remote: { route: 'not-a-path' } })
    expect(r.diagnostics.map((d) => d.code)).toEqual(['schema.dinkster.badComboRemote'])
    expect(widgetOf(r)).toEqual({
      widgetType: 'COMBO', options: { options: ['euler'] }, default: 'euler',
    })
  })

  it('neither options nor remote is invalid: warn and drop the descriptor', () => {
    const r = decode({ type: 'COMBO' })
    expect(r.diagnostics.map((d) => d.code)).toEqual(['schema.dinkster.badCombo'])
    expect(widgetOf(r)).toBeUndefined()
  })
})

describe('BOOLEAN widget descriptor (wire v10)', () => {
  const decode = (widget: Record<string, unknown>) => parseDinksterNodes({
    schemaVersion: PREDECESSOR_WIDGET_WIRE_VERSION,
    nodes: {
      'test.bool': {
        schemaVersion: PREDECESSOR_WIDGET_WIRE_VERSION,
        interface: [{
          role: 'input',
          id: 'enabled',
          type: { kind: 'concrete', types: ['core.boolean'] },
          default: true,
          widget,
        }],
      },
    },
  })
  const widgetOf = (r: ReturnType<typeof parseDinksterNodes>) => inputsOf(r.schemas.get('test.bool')!)[0]!.widget

  it('labelOn/labelOff decode into the BOOLEAN spec options', () => {
    const r = decode({ type: 'BOOLEAN', labelOn: 'enable', labelOff: 'disable' })
    expect(r.diagnostics).toHaveLength(0)
    expect(widgetOf(r)).toEqual({
      widgetType: 'BOOLEAN', options: { labelOn: 'enable', labelOff: 'disable' }, default: true,
    })
  })

  it('one-sided labels decode; the empty string counts as absent (omitted-when-empty)', () => {
    const r = decode({ type: 'BOOLEAN', labelOn: 'enable', labelOff: '' })
    expect(widgetOf(r)).toEqual({
      widgetType: 'BOOLEAN', options: { labelOn: 'enable' }, default: true,
    })
  })

  it('a malformed label drops alone with a warning, never the widget', () => {
    const r = decode({ type: 'BOOLEAN', labelOn: 7, labelOff: 'disable' })
    expect(r.diagnostics.map((d) => d.code)).toEqual(['schema.dinkster.badBooleanLabel'])
    expect(widgetOf(r)).toEqual({
      widgetType: 'BOOLEAN', options: { labelOff: 'disable' }, default: true,
    })
  })

  it('a bare core.boolean input without a descriptor still implies the toggle', () => {
    const r = parseDinksterNodes({
      schemaVersion: PREDECESSOR_WIDGET_WIRE_VERSION,
      nodes: {
        'test.bool': {
          schemaVersion: PREDECESSOR_WIDGET_WIRE_VERSION,
          interface: [{ role: 'input', id: 'enabled', type: { kind: 'concrete', types: ['core.boolean'] }, default: false }],
        },
      },
    })
    expect(widgetOf(r)).toEqual({ widgetType: 'BOOLEAN', options: {}, default: false })
  })
})

describe('NUMBER widget descriptor (wire v11)', () => {
  const decode = (socket: string, widget: Record<string, unknown>) => parseDinksterNodes({
    schemaVersion: PREDECESSOR_WIDGET_WIRE_VERSION,
    nodes: {
      'test.num': {
        schemaVersion: PREDECESSOR_WIDGET_WIRE_VERSION,
        interface: [{
          role: 'input',
          id: 'value',
          type: { kind: 'concrete', types: [socket] },
          default: 0,
          widget,
        }],
      },
    },
  })
  const widgetOf = (r: ReturnType<typeof parseDinksterNodes>) => inputsOf(r.schemas.get('test.num')!)[0]!.widget

  it('int NUMBER decodes constraints into the INT spec; the socket picks the kind', () => {
    const r = decode('core.int', { type: 'NUMBER', min: 0, max: 100, step: 1 })
    expect(r.diagnostics).toHaveLength(0)
    expect(widgetOf(r)).toEqual({ widgetType: 'INT', options: { min: 0, max: 100, step: 1 }, default: 0 })
  })

  it('float NUMBER decodes into the FLOAT spec with fractional fields', () => {
    const r = decode('core.float', { type: 'NUMBER', min: -1.5, step: 0.1 })
    expect(r.diagnostics).toHaveLength(0)
    expect(widgetOf(r)).toEqual({ widgetType: 'FLOAT', options: { min: -1.5, step: 0.1 }, default: 0 })
  })

  it('absent min/max means unbounded: only the present fields decode', () => {
    const r = decode('core.int', { type: 'NUMBER', step: 8 })
    expect(widgetOf(r)).toEqual({ widgetType: 'INT', options: { step: 8 }, default: 0 })
  })

  it('controlAfterGenerate seeds the controller with its initial mode', () => {
    const r = decode('core.int', { type: 'NUMBER', min: 0, controlAfterGenerate: 'fixed' })
    expect(r.diagnostics).toHaveLength(0)
    expect(widgetOf(r)).toEqual({
      widgetType: 'INT', options: { min: 0 },
      controller: 'after_generate', controllerInitial: 'fixed', default: 0,
    })
  })

  it('an unknown controlAfterGenerate mode drops the control alone, never the widget', () => {
    const r = decode('core.int', { type: 'NUMBER', min: 0, controlAfterGenerate: 'shuffle' })
    expect(r.diagnostics.map((d) => d.code)).toEqual(['schema.dinkster.badControlAfterGenerate'])
    expect(widgetOf(r)).toEqual({ widgetType: 'INT', options: { min: 0 }, default: 0 })
  })

  it('min > max drops both fields with a warning; other fields survive', () => {
    const r = decode('core.int', { type: 'NUMBER', min: 10, max: 1, step: 2 })
    expect(r.diagnostics.map((d) => d.code)).toEqual(['schema.dinkster.badNumberRange'])
    expect(widgetOf(r)).toEqual({ widgetType: 'INT', options: { step: 2 }, default: 0 })
  })

  it('a nonpositive step drops alone with a warning', () => {
    const r = decode('core.float', { type: 'NUMBER', min: 0, step: 0 })
    expect(r.diagnostics.map((d) => d.code)).toEqual(['schema.dinkster.badNumberField'])
    expect(widgetOf(r)).toEqual({ widgetType: 'FLOAT', options: { min: 0 }, default: 0 })
  })

  it('int sockets enforce the JS-safe-integer policy on bounds; floats accept fractions', () => {
    const unsafe = decode('core.int', { type: 'NUMBER', min: 0, max: 9007199254740993 })
    expect(unsafe.diagnostics.map((d) => d.code)).toEqual(['schema.dinkster.badNumberField'])
    expect(widgetOf(unsafe)).toEqual({ widgetType: 'INT', options: { min: 0 }, default: 0 })
    const fractional = decode('core.int', { type: 'NUMBER', step: 0.5 })
    expect(fractional.diagnostics.map((d) => d.code)).toEqual(['schema.dinkster.badNumberField'])
    expect(widgetOf(fractional)).toEqual({ widgetType: 'INT', options: {}, default: 0 })
  })

  it('a non-finite field drops alone with a warning', () => {
    const r = decode('core.float', { type: 'NUMBER', min: Number.NaN, max: 5 })
    expect(r.diagnostics.map((d) => d.code)).toEqual(['schema.dinkster.badNumberField'])
    expect(widgetOf(r)).toEqual({ widgetType: 'FLOAT', options: { max: 5 }, default: 0 })
  })

  it('NUMBER on a non-numeric socket drops the descriptor and preserves primitive inference', () => {
    const r = decode('core.string', { type: 'NUMBER', min: 0 })
    expect(r.diagnostics.map((d) => d.code)).toEqual(['schema.dinkster.badNumberSocket'])
    expect(widgetOf(r)).toEqual({ widgetType: 'STRING', options: {}, default: 0 })
  })

  it('a descriptor-less numeric input still infers its primitive widget (absence != widgetless)', () => {
    const r = parseDinksterNodes({
      schemaVersion: PREDECESSOR_WIDGET_WIRE_VERSION,
      nodes: {
        'test.num': {
          schemaVersion: PREDECESSOR_WIDGET_WIRE_VERSION,
          interface: [{ role: 'input', id: 'value', type: { kind: 'concrete', types: ['core.int'] }, default: 3 }],
        },
      },
    })
    expect(widgetOf(r)).toEqual({ widgetType: 'INT', options: {}, default: 3 })
  })
})

describe('STRING multiline descriptor (wire v11)', () => {
  const decode = (socket: string, widget?: Record<string, unknown>) => parseDinksterNodes({
    schemaVersion: PREDECESSOR_WIDGET_WIRE_VERSION,
    nodes: {
      'test.str': {
        schemaVersion: PREDECESSOR_WIDGET_WIRE_VERSION,
        interface: [{
          role: 'input',
          id: 'text',
          type: { kind: 'concrete', types: [socket] },
          default: '',
          ...(widget !== undefined ? { widget } : {}),
        }],
      },
    },
  })
  const widgetOf = (r: ReturnType<typeof parseDinksterNodes>) => inputsOf(r.schemas.get('test.str')!)[0]!.widget

  it('multiline: true decodes into the STRING spec options', () => {
    const r = decode('core.string', { type: 'STRING', multiline: true })
    expect(r.diagnostics).toHaveLength(0)
    expect(widgetOf(r)).toEqual({ widgetType: 'STRING', options: { multiline: true }, default: '' })
  })

  it('a descriptor without multiline: true falls back to the single-line widget with a warning', () => {
    for (const widget of [{ type: 'STRING' }, { type: 'STRING', multiline: false }, { type: 'STRING', multiline: 'yes' }]) {
      const r = decode('core.string', widget)
      expect(r.diagnostics.map((d) => d.code)).toEqual(['schema.dinkster.badStringMultiline'])
      expect(widgetOf(r)).toEqual({ widgetType: 'STRING', options: {}, default: '' })
    }
  })

  it('STRING on a non-string socket drops the descriptor and preserves primitive inference', () => {
    const r = decode('core.int', { type: 'STRING', multiline: true })
    expect(r.diagnostics.map((d) => d.code)).toEqual(['schema.dinkster.badStringSocket'])
    expect(widgetOf(r)).toEqual({ widgetType: 'INT', options: {}, default: '' })
  })

  it('a descriptor-less string input stays the inferred single-line widget', () => {
    const r = decode('core.string')
    expect(widgetOf(r)).toEqual({ widgetType: 'STRING', options: {}, default: '' })
  })
})

describe('per-input displayName (wire v11)', () => {
  const T = (name: string) => ({ kind: 'concrete', types: [name] })
  const decode = (entry: Record<string, unknown>) => parseDinksterNodes({
    schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION,
    nodes: {
      'test.dn': {
        schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION,
        interface: [{ role: 'input', id: 'value', type: T('core.int'), ...entry }],
      },
    },
  })
  const inputOf = (r: ReturnType<typeof parseDinksterNodes>) => inputsOf(r.schemas.get('test.dn')!)[0]!

  it('decodes onto the InputSpec; label machinery already prefers it over the id', () => {
    const r = decode({ displayName: 'Noise seed' })
    expect(r.diagnostics).toHaveLength(0)
    expect(inputOf(r).displayName).toBe('Noise seed')
  })

  it('empty and absent both fall back to the id (omitted-when-empty)', () => {
    expect(inputOf(decode({ displayName: '' })).displayName).toBeUndefined()
    expect(inputOf(decode({})).displayName).toBeUndefined()
  })

  it('a non-string displayName warns and falls back to the id', () => {
    const r = decode({ displayName: 7 })
    expect(r.diagnostics.map((d) => d.code)).toEqual(['schema.dinkster.badDisplayName'])
    expect(inputOf(r).displayName).toBeUndefined()
  })

  it('dynamic-slot variant dependent inputs share the same decoding', () => {
    const r = parseDinksterNodes({
      schemaVersion: 14,
      nodes: {
        'test.slot': {
          schemaVersion: 14,
          interface: [{
            role: 'dynamicSlot',
            id: 'source',
            variants: [{
              key: 'text',
              type: T('core.string'),
              inputs: [{ id: 'prefix', type: T('core.string'), displayName: 'Prefix text' }],
            }],
          }],
        },
      },
    })
    const slot = inputsOf(r.schemas.get('test.slot')!)[0]!
    if (slot.dynamic?.kind !== 'dynamicSlot') throw new Error('expected dynamicSlot')
    expect(slot.dynamic.variants![0]!.inputs[0]!.displayName).toBe('Prefix text')
  })
})

describe('core.combo concrete atom (wire v14)', () => {
  const T = (name: string) => ({ kind: 'concrete', types: [name] })
  const decoded = parseDinksterNodes({
    schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION,
    nodes: {
      'test.combo': {
        schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION,
        interface: [
          {
            role: 'input', id: 'choice', type: T('core.combo'), required: true,
            widget: { type: 'COMBO', options: ['alpha'], remote: { route: '/api/choices', refreshButton: true } },
          },
          { role: 'output', id: 'choice', type: T('core.combo') },
        ],
      },
    },
  })

  it('decodes core.combo on both sockets with the unchanged COMBO descriptor', () => {
    expect(decoded.diagnostics).toEqual([])
    const schema = decoded.schemas.get('test.combo')!
    expect(inputsOf(schema)[0]).toMatchObject({
      type: { kind: 'concrete', name: 'core.combo' },
      widget: {
        widgetType: 'COMBO', options: { options: ['alpha'] },
        remote: { route: '/api/choices', refreshButton: true },
      },
    })
    expect(outputsOf(schema)[0]!.type).toEqual({ kind: 'concrete', name: 'core.combo' })
    expect(JSON.stringify(schema)).not.toContain('comboSource')
  })
})

describe('dynamicSlot interface role (wire v6, backend c2ac572)', () => {
  const T = (name: string) => ({ kind: 'concrete', types: [name] })
  const slotNode = (variants: unknown[], extra?: Record<string, unknown>) => ({
    schemaVersion: 6,
    nodes: {
      'test.slot': {
        nodeType: 'test.slot',
        interface: [
          { role: 'dynamicSlot', id: 'source', required: true, doc: 'pick a source', variants, ...extra },
          { role: 'output', id: 'out', type: T('core.string') },
        ],
      },
    },
  })

  it('decodes variants with dependents, deriving the acceptance union and required-ness', () => {
    const r = parseDinksterNodes(slotNode([
      {
        key: 'text',
        type: T('core.string'),
        doc: 'plain text',
        inputs: [{ id: 'prefix', type: T('core.string'), required: false, default: 'p' }],
      },
      { key: 'image', type: T('IMAGE'), inputs: [] },
    ]))
    expect(r.diagnostics).toEqual([])
    const slot = inputsOf(r.schemas.get('test.slot')!)[0]!
    expect(slot.id).toBe('source')
    expect(slot.optional).toBe(false) // required: true
    expect(slot.tooltip).toBe('pick a source')
    expect(slot.type).toEqual({ kind: 'union', names: ['core.string', 'IMAGE'] })
    if (slot.dynamic?.kind !== 'dynamicSlot') throw new Error('expected dynamicSlot')
    expect(slot.dynamic.inputs).toEqual([]) // native wire: no shared dependents
    expect(slot.dynamic.variants?.map((v) => [v.key, v.tooltip])).toEqual([
      ['text', 'plain text'],
      ['image', undefined],
    ])
    // Dependents run through ordinary input decoding: widget derivation included.
    const prefix = slot.dynamic.variants![0]!.inputs[0]!
    expect(prefix.optional).toBe(true)
    expect(prefix.widget).toEqual({ widgetType: 'STRING', options: {}, default: 'p' })
  })

  it('a single variant specializes the socket; a list variant falls to that type', () => {
    const single = parseDinksterNodes(slotNode([{ key: 'only', type: T('MODEL'), inputs: [] }]))
    expect(inputsOf(single.schemas.get('test.slot')!)[0]!.type).toEqual({ kind: 'concrete', name: 'MODEL' })
    const list = parseDinksterNodes(slotNode([{ key: 'many', type: { kind: 'list', element: T('IMAGE') }, inputs: [] }]))
    expect(inputsOf(list.schemas.get('test.slot')!)[0]!.type).toEqual({ kind: 'list', element: { kind: 'concrete', name: 'IMAGE' } })
    // Mixed concrete + list cannot union: wildcard acceptance, solver
    // specializes once a variant is chosen.
    const mixed = parseDinksterNodes(slotNode([
      { key: 'one', type: T('IMAGE'), inputs: [] },
      { key: 'many', type: { kind: 'list', element: T('IMAGE') }, inputs: [] },
    ]))
    expect(inputsOf(mixed.schemas.get('test.slot')!)[0]!.type).toEqual({ kind: 'wildcard' })
  })

  it('warn-and-drops keys the backend refuses at construction: bad grammar, duplicates, duplicate dependents', () => {
    const r = parseDinksterNodes(slotNode([
      { key: 'has.dot', type: T('IMAGE'), inputs: [] },
      { key: 'ok', type: T('IMAGE'), inputs: [] },
      { key: 'ok', type: T('MASK'), inputs: [] },
      { key: 'dup-dep', type: T('MASK'), inputs: [{ id: 'x', type: T('core.int') }, { id: 'x', type: T('core.float') }] },
    ]))
    expect(r.diagnostics.map((d) => d.code).sort()).toEqual([
      'schema.slot.badVariantKey',
      'schema.slot.duplicateDependent',
      'schema.slot.duplicateVariantKey',
    ])
    const slot = inputsOf(r.schemas.get('test.slot')!)[0]!
    if (slot.dynamic?.kind !== 'dynamicSlot') throw new Error('expected dynamicSlot')
    expect(slot.dynamic.variants?.map((v) => v.key)).toEqual(['ok', 'dup-dep'])
    expect(slot.dynamic.variants![1]!.inputs.map((i) => i.id)).toEqual(['x'])
  })

  it('an empty variant list warns and leaves a connectable wildcard slot', () => {
    const r = parseDinksterNodes(slotNode([]))
    expect(r.diagnostics.map((d) => d.code)).toEqual(['schema.slot.noVariants'])
    const slot = inputsOf(r.schemas.get('test.slot')!)[0]!
    expect(slot.type).toEqual({ kind: 'wildcard' })
    if (slot.dynamic?.kind !== 'dynamicSlot') throw new Error('expected dynamicSlot')
    expect(slot.dynamic.variants).toBeUndefined()
  })

  it('a malformed variant TYPE fails the node, matching input-type strictness', () => {
    const r = parseDinksterNodes(slotNode([{ key: 'bad', type: { kind: 'mystery' }, inputs: [] }]))
    expect(r.schemas.size).toBe(0)
    expect(r.diagnostics.some((d) => d.code === 'schema.parse.threw')).toBe(true)
  })
})

describe('deprecation and search visibility (wire v3 additive fields)', () => {
  const decode = (extra: Record<string, unknown>) => {
    const r = parseDinksterNodes({
      schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION,
      nodes: { n: { interface: [], ...extra } },
    })
    return { schema: r.schemas.get('n')!, diagnostics: r.diagnostics }
  }

  it('omitted fields decode to undefined and normal listing', () => {
    const { schema: s, diagnostics: d } = decode({})
    expect(s.deprecation).toBeUndefined()
    expect(s.searchVisibility).toBeUndefined()
    expect(searchVisibilityOf(s)).toBe('normal')
    expect(d).toEqual([])
  })

  it('decodes host-normalized execution arm capabilities without worker names', () => {
    expect(decode({ executionArms: ['native', 'comfyui', 'native'] }).schema.executionArms)
      .toEqual(['native', 'comfyui'])
    expect(decode({ executionArms: ['unknown'] }).schema.executionArms).toBeUndefined()
  })

  it('a complete deprecation object decodes field-for-field', () => {
    const { schema: s } = decode({
      deprecation: { message: 'use new.thing', since: '1.2', replacement: 'new.thing' },
    })
    expect(s.deprecation).toEqual({ message: 'use new.thing', since: '1.2', replacement: 'new.thing' })
    // Frontend inference: deprecation without explicit visibility soft-demotes.
    expect(searchVisibilityOf(s)).toBe('deprecated')
  })

  it('message-only deprecation omits since/replacement (never null)', () => {
    const { schema: s } = decode({ deprecation: { message: 'going away' } })
    expect(s.deprecation).toEqual({ message: 'going away' })
    expect('since' in s.deprecation!).toBe(false)
    expect('replacement' in s.deprecation!).toBe(false)
  })

  it('each visibility decodes; explicit normal decodes as omission', () => {
    expect(decode({ searchVisibility: 'deprecated' }).schema.searchVisibility).toBe('deprecated')
    expect(decode({ searchVisibility: 'hidden' }).schema.searchVisibility).toBe('hidden')
    const normal = decode({ searchVisibility: 'normal' })
    expect(normal.schema.searchVisibility).toBeUndefined()
    expect(normal.diagnostics).toEqual([])
  })

  it('visibility is orthogonal: hidden without deprecation, deprecated without demotion', () => {
    const hidden = decode({ searchVisibility: 'hidden' }).schema
    expect(hidden.deprecation).toBeUndefined()
    expect(searchVisibilityOf(hidden)).toBe('hidden')
    const explicit = decode({ deprecation: { message: 'x' }, searchVisibility: 'hidden' }).schema
    expect(searchVisibilityOf(explicit)).toBe('hidden') // explicit wins over inference
  })

  it('malformed deprecation warns and drops the field; the node survives', () => {
    for (const bad of ['use new.thing', { message: '' }, { since: '1.2' }, 42]) {
      const { schema: s, diagnostics: d } = decode({ deprecation: bad })
      expect(s).toBeDefined()
      expect(s.deprecation).toBeUndefined()
      expect(d.some((x) => x.code === 'schema.dinkster.badDeprecation')).toBe(true)
    }
  })

  it('a self-pointing replacement drops the pointer but keeps the message', () => {
    const { schema: s, diagnostics: d } = decode({ deprecation: { message: 'oops', replacement: 'n' } })
    expect(s.deprecation).toEqual({ message: 'oops' })
    expect(d.some((x) => x.code === 'schema.dinkster.badDeprecation')).toBe(true)
  })

  it('unknown searchVisibility warns and falls back to normal', () => {
    const { schema: s, diagnostics: d } = decode({ searchVisibility: 'shadowbanned' })
    expect(s.searchVisibility).toBeUndefined()
    expect(searchVisibilityOf(s)).toBe('normal')
    expect(d.some((x) => x.code === 'schema.dinkster.badSearchVisibility')).toBe(true)
  })

  it('presentation metadata never costs interface decoding', () => {
    const { schema: s } = decode({
      deprecation: { message: 'legacy' },
      searchVisibility: 'hidden',
      interface: [{ role: 'output', id: 'out', type: { kind: 'concrete', types: ['core.int'] } }],
    })
    expect(s.items.map((i) => i.id)).toEqual(['out'])
  })

  it('replacements decode verbatim through the shared rule validator', () => {
    const rule = {
      from: 'old.thing',
      note: 'renamed in 0.4',
      cases: [
        {
          to: 'new.thing',
          when: { kind: 'inputConnected', input: 'image' },
          inputs: { image: { kind: 'copy', input: 'image' } },
          outputs: { out: 'result' },
        },
        { to: 'new.thing' },
      ],
    }
    const { schema: s, diagnostics: d } = decode({ replacements: [rule] })
    expect(s.replacements).toEqual([rule])
    expect(d).toEqual([])
  })

  it('a malformed rule is skipped with a warning; valid siblings survive', () => {
    const good = { from: 'a', cases: [{ to: 'b' }] }
    const noFallback = { from: 'a', cases: [{ to: 'b', when: { kind: 'inputConnected', input: 'x' } }] }
    const { schema: s, diagnostics: d } = decode({ replacements: [noFallback, good] })
    expect(s.replacements).toEqual([good])
    expect(d.some((x) => x.code === 'schema.dinkster.badReplacements')).toBe(true)
  })

  it('non-array replacements warns and is ignored; empty array normalizes to omitted', () => {
    const bad = decode({ replacements: { from: 'a' } })
    expect(bad.schema.replacements).toBeUndefined()
    expect(bad.diagnostics.some((x) => x.code === 'schema.dinkster.badReplacements')).toBe(true)
    expect(decode({ replacements: [] }).schema.replacements).toBeUndefined()
  })
})
