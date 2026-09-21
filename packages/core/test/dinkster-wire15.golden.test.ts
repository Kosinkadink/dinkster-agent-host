import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  asNodeId,
  defaultValuesOf,
  DINKSTER_ACCEPTED_WIRE_VERSIONS,
  DINKSTER_SCHEMA_WIRE_VERSION,
  elabInputsOf,
  elaborateInterface,
  initialDynamicStateOf,
  inputsOf,
  outputsOf,
  parseDinksterNodes,
  parseDinksterSchemaWire15,
  parseDinksterSchemaWire16,
  selectorBranchDisplay,
  type DinksterWireSchema,
  type Connectivity,
} from '../src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(
  readFileSync(join(here, '../fixtures/dinkster-nodes-wire15.json'), 'utf8'),
) as {
  valid: Record<string, DinksterWireSchema>
  invalid: Record<string, DinksterWireSchema>
}
const resizeImageMaskWire = JSON.parse(
  readFileSync(join(here, '../fixtures/dinkster-resize-image-mask-wire16.json'), 'utf8'),
) as DinksterWireSchema

const decode = (name: string) => {
  const result = parseDinksterSchemaWire15(name, fixture.valid[name]!)
  expect(result.diagnostics, name).toEqual([])
  expect(result.schema, name).toBeDefined()
  return result.schema!
}

const connected = (...ports: string[]): Connectivity => ({
  isInputConnected: (port) => ports.includes(port),
  isOutputConnected: () => false,
  inputPorts: () => ports,
})

const portsOf = (schema: ReturnType<typeof decode>, state: Parameters<typeof elaborateInterface>[1], facts?: Connectivity) =>
  elabInputsOf(elaborateInterface(schema, state, facts)).map((input) => [input.address.port, input.apiName])

describe('schema wire 15 recursive dynamic entries', () => {
  const selectorInterface = [
    { role: 'input', id: 'switch', type: { kind: 'concrete', types: ['core.boolean'] }, required: true, default: false },
    { role: 'input', id: 'on_false', type: { kind: 'concrete', types: ['comfy.IMAGE'] }, required: true },
    { role: 'input', id: 'on_true', type: { kind: 'concrete', types: ['comfy.IMAGE'] }, required: true },
    { role: 'output', id: 'result', type: { kind: 'concrete', types: ['comfy.IMAGE'] } },
  ] as const
  const selectorWire = (): DinksterWireSchema => ({
    schemaVersion: 15,
    interface: structuredClone(selectorInterface),
    selector: { input: 'switch', branches: { false: 'on_false', true: 'on_true' } },
  })

  it('decodes a valid selector and exposes its branch-display fact', () => {
    const result = parseDinksterSchemaWire15('selector', selectorWire())
    expect(result.diagnostics).toEqual([])
    expect(result.schema?.selector).toEqual({
      input: 'switch',
      branches: { false: 'on_false', true: 'on_true' },
    })
    expect(selectorBranchDisplay(result.schema!, { switch: false })).toEqual({
      on_false: 'active', on_true: 'inactive',
    })
    expect(selectorBranchDisplay(result.schema!, { switch: true })).toEqual({
      on_true: 'active', on_false: 'inactive',
    })
    expect(selectorBranchDisplay(result.schema!, {})).toEqual({
      on_false: 'neutral', on_true: 'neutral',
    })
  })

  it.each([
    ['missing selector input id', (wire: Record<string, any>) => { delete wire.selector.input }],
    ['unknown selector input id', (wire: Record<string, any>) => { wire.selector.input = 'missing' }],
    ['unknown false branch input id', (wire: Record<string, any>) => { wire.selector.branches.false = 'missing' }],
    ['unknown true branch input id', (wire: Record<string, any>) => { wire.selector.branches.true = 'missing' }],
    ['selector input equals a branch input', (wire: Record<string, any>) => { wire.selector.input = 'on_false' }],
    ['identical branch inputs', (wire: Record<string, any>) => { wire.selector.branches.true = 'on_false' }],
    ['missing false branch key', (wire: Record<string, any>) => { delete wire.selector.branches.false }],
    ['extra branch key', (wire: Record<string, any>) => { wire.selector.branches.other = 'on_false' }],
    ['renamed branch key', (wire: Record<string, any>) => {
      wire.selector.branches.no = wire.selector.branches.false
      delete wire.selector.branches.false
    }],
    ['selector is a scalar', (wire: Record<string, any>) => { wire.selector = true }],
    ['selector input is not a string', (wire: Record<string, any>) => { wire.selector.input = 1 }],
    ['selector input has the wrong type', (wire: Record<string, any>) => {
      wire.interface[0].type = { kind: 'concrete', types: ['core.int'] }
    }],
    ['selector input is dynamic', (wire: Record<string, any>) => {
      wire.interface[0] = {
        role: 'dynamicSlot', id: 'switch', slotType: { kind: 'concrete', types: ['core.boolean'] },
        required: false, inputs: [],
      }
    }],
    ['selector branches is a scalar', (wire: Record<string, any>) => { wire.selector.branches = false }],
    ['branch input id is not a string', (wire: Record<string, any>) => { wire.selector.branches.true = 1 }],
    ['selector branch is dynamic', (wire: Record<string, any>) => {
      wire.interface[1] = {
        role: 'dynamicSlot', id: 'on_false', slotType: { kind: 'concrete', types: ['comfy.IMAGE'] },
        required: false, inputs: [],
      }
    }],
    ['branch type differs from output', (wire: Record<string, any>) => {
      wire.interface[2].type = { kind: 'concrete', types: ['comfy.MASK'] }
    }],
    ['selector has no output', (wire: Record<string, any>) => { wire.interface.pop() }],
    ['selector output is dynamic', (wire: Record<string, any>) => {
      wire.interface[3] = {
        role: 'outputFamily', id: 'result', type: { kind: 'concrete', types: ['comfy.IMAGE'] }, minMembers: 0,
      }
    }],
    ['selector on a multi-output schema', (wire: Record<string, any>) => {
      wire.interface.push({ role: 'output', id: 'other', type: { kind: 'concrete', types: ['comfy.IMAGE'] } })
    }],
  ])('rejects the whole node for malformed selector: %s', (_name, mutate) => {
    const wire = selectorWire() as Record<string, any>
    mutate(wire)
    const result = parseDinksterSchemaWire15('bad-selector', wire)
    expect(result.schema).toBeUndefined()
    expect(result.diagnostics.at(-1)).toMatchObject({ severity: 'error', code: 'schema.parse.threw' })
  })

  it('keeps selector-absent wire-15 decoding byte-identical', () => {
    const absent: DinksterWireSchema = { schemaVersion: 15, interface: structuredClone(selectorInterface) }
    const explicitUndefined: DinksterWireSchema = { ...absent, selector: undefined }
    const before = parseDinksterSchemaWire15('absent', absent)
    const after = parseDinksterSchemaWire15('absent', explicitUndefined)
    expect(JSON.stringify(after)).toBe(JSON.stringify(before))
    expect(before.schema).not.toHaveProperty('selector')
  })

  it('decodes prefix, names, native, grouped, and nested Autogrow fixtures', () => {
    const prefix = inputsOf(decode('prefix-family'))[0]!
    expect(prefix.dynamic).toEqual({
      kind: 'autogrow',
      materialization: 'wire15',
      template: [{ kind: 'input', id: 'image', type: { kind: 'concrete', name: 'comfy.IMAGE' }, optional: false }],
      naming: { kind: 'prefix', prefix: 'image', min: 1, max: 8 },
    })

    const families = inputsOf(decode('names-and-native-families'))
    expect(families.map((input) => input.dynamic)).toMatchObject([
      { kind: 'autogrow', naming: { kind: 'names', names: ['left', 'right'], min: 1 } },
      { kind: 'autogrow', naming: { kind: 'names', names: [] } },
      // A family with no wire naming vocabulary mints members with the
      // family id as the prefix (the backend accepts any structural suffix).
      { kind: 'autogrow', naming: { kind: 'prefix', prefix: 'native', min: 1, max: 3 } },
    ])

    const grouped = inputsOf(decode('grouped-and-nested-families'))
    expect(grouped[0]!.dynamic).toMatchObject({
      kind: 'autogrow',
      template: [{ id: 'image' }, { id: 'mask' }],
      naming: { kind: 'prefix', prefix: 'pair', max: 4 },
    })
    expect(grouped[1]!.dynamic).toMatchObject({
      kind: 'autogrow',
      template: [{ id: 'inner', dynamic: { kind: 'autogrow', naming: { kind: 'prefix', prefix: 'sub' } } }],
    })
  })

  it('decodes recursive DynamicCombo and both DynamicSlot forms with dependents', () => {
    const combos = inputsOf(decode('recursive-combos'))
    expect(combos[0]!.widget).toEqual({
      widgetType: 'COMBO', options: { options: ['none', 'batch'] }, default: 'none',
    })
    expect(combos[0]!.dynamic).toMatchObject({
      kind: 'dynamicCombo',
      defaultOption: 'none',
      options: [
        { key: 'none', inputs: [] },
        { key: 'batch', inputs: [{ id: 'frames', dynamic: { kind: 'autogrow' } }, { id: 'quality', dynamic: { kind: 'dynamicCombo' } }] },
      ],
    })
    expect(combos[1]!.dynamic).toEqual({ kind: 'dynamicCombo', materialization: 'wire15', options: [] })
    expect(combos[1]!.widget).toEqual({ widgetType: 'COMBO', options: { options: [] } })

    const variant = inputsOf(decode('variant-slot'))[0]!
    expect(variant.dynamic).toMatchObject({
      kind: 'dynamicSlot',
      slotType: { kind: 'union', names: ['comfy.MASK', 'comfy.IMAGE'] },
      inputs: [{ id: 'strength' }],
      variants: [
        { key: 'mask', inputs: [{ id: 'invert' }], tooltip: 'Mask specialization' },
        { key: 'image', inputs: [] },
      ],
    })
    const open = inputsOf(decode('open-slot'))[0]!
    expect(open).toMatchObject({ id: 'model', forceInput: true, displayName: 'Model' })
    expect(open.optional).toBe(true)
    expect(open.dynamic).toMatchObject({ kind: 'dynamicSlot', forceInput: true, inputs: [{ id: 'weight' }] })
  })

  it('materializes the current ResizeImageMaskNode raw-wire selector and first branch', () => {
    const parsed = parseDinksterSchemaWire16('comfy.ResizeImageMaskNode', resizeImageMaskWire)
    expect(parsed.diagnostics).toEqual([])
    const schema = parsed.schema!
    const combo = inputsOf(schema).find((input) => input.id === 'resize_type')!
    expect(combo.dynamic?.kind).toBe('dynamicCombo')
    if (combo.dynamic?.kind !== 'dynamicCombo') return
    expect(combo.dynamic.options.map((option) => option.key)).toEqual([
      'scale dimensions',
      'scale by multiplier',
      'scale longer dimension',
      'scale shorter dimension',
      'scale width',
      'scale height',
      'scale total pixels',
      'match size',
      'scale to multiple',
    ])
    expect(initialDynamicStateOf(schema)).toEqual({
      resize_type: { selected: 'scale dimensions' },
    })
    expect(defaultValuesOf(schema)).toEqual({ scale_method: 'area' })

    const node = { values: {}, dynamic: {} }
    const elaborated = elaborateInterface(schema, node)
    expect(elaborated.diagnostics).toEqual([])
    expect(elabInputsOf(elaborated).map((input) => input.address.port)).toEqual([
      'input',
      'scale_method',
      'resize_type',
      'resize_type.width',
      'resize_type.height',
      'resize_type.crop',
    ])
    expect(elabInputsOf(elaborated).find((input) => input.address.port === 'resize_type')).toMatchObject({
      derivedValue: 'scale dimensions',
      spec: { widget: { widgetType: 'COMBO', options: { options: combo.dynamic.options.map((option) => option.key) } } },
    })
    expect(elabInputsOf(elaborated).find((input) => input.address.port === 'scale_method')?.spec.widget).toEqual({
      widgetType: 'COMBO',
      options: { options: ['nearest-exact', 'bilinear', 'area', 'bicubic', 'lanczos'] },
      default: 'area',
    })
    expect(elaborated.submissionValues).toEqual([])
    expect(node.dynamic).toEqual({})
  })

  it('accepts interior single spaces in DynamicCombo option keys with exact-string identity', () => {
    const schema = decode('punctuation-option-keys')
    const combo = inputsOf(schema)[0]!
    expect(combo.widget).toEqual({
      widgetType: 'COMBO',
      options: { options: ['Flux.2 [pro]', 'Flux.2 [max]', 'Flux.2 [Pro]'] },
      default: 'Flux.2 [pro]',
    })
    expect(combo.dynamic).toMatchObject({
      kind: 'dynamicCombo',
      defaultOption: 'Flux.2 [pro]',
      options: [
        { key: 'Flux.2 [pro]', inputs: [{ id: 'scale' }] },
        { key: 'Flux.2 [max]', inputs: [] },
        { key: 'Flux.2 [Pro]', inputs: [] },
      ],
    })

    const elaborated = elaborateInterface(schema, {
      values: { 'mode.scale': 2 },
      dynamic: { mode: { selected: 'Flux.2 [pro]' } },
    })
    expect(elaborated.diagnostics).toEqual([])
    expect(elabInputsOf(elaborated).map((input) => [input.address.port, input.apiName])).toEqual([
      ['mode', 'mode'],
      ['mode.scale', 'mode.scale'],
    ])
    expect(elabInputsOf(elaborated)[0]).toMatchObject({
      derivedValue: 'Flux.2 [pro]',
      wire15Materialization: true,
    })
    expect(elaborated.submissionValues).toEqual([])
  })

  it('accepts every printable non-space ASCII character in a DynamicCombo option token', () => {
    const key = Array.from({ length: 0x7e - 0x21 + 1 }, (_, index) => String.fromCharCode(0x21 + index)).join('')
    const result = parseDinksterSchemaWire15('all-printable-option-key', {
      schemaVersion: 15,
      interface: [{ role: 'dynamicCombo', id: 'mode', options: [{ key, inputs: [] }], default: key }],
    })
    expect(result.diagnostics).toEqual([])
    expect(inputsOf(result.schema!)[0]).toMatchObject({
      widget: { options: { options: [key] }, default: key },
      dynamic: { options: [{ key }], defaultOption: key },
    })
  })

  it('accepts the BFL sibling option keys without triggering the bracket-alias guard', () => {
    expect(decode('punctuation-option-keys')).toBeDefined()
  })

  it('retains variable TypeExprs at every legal recursive depth and presentation flags', () => {
    const inputs = inputsOf(decode('variables-everywhere'))
    expect(inputs[0]).toMatchObject({
      type: { kind: 'variable', templateId: 'T' }, forceInput: true, advanced: true,
    })
    expect(inputs[1]!.dynamic).toMatchObject({ template: [{ type: { kind: 'variable', templateId: 'T' } }] })
    expect(inputs[2]!.dynamic).toMatchObject({
      options: [{ inputs: [{ type: { kind: 'list', element: { kind: 'variable', templateId: 'T' } } }] }],
    })
    expect(inputs[3]!.dynamic).toMatchObject({
      inputs: [{ type: { kind: 'variable', templateId: 'T' } }],
      variants: [{ type: { kind: 'asset', element: { kind: 'concrete', name: 'core.string' } }, inputs: [{ type: { kind: 'asset', element: { kind: 'variable', templateId: 'T' } } }] }],
    })
    expect(inputs[4]!.dynamic).toMatchObject({
      slotType: { kind: 'list', element: { kind: 'variable', templateId: 'T' } },
      inputs: [{ type: { kind: 'variable', templateId: 'T' } }],
    })
    const absentFlags = inputsOf(decode('names-and-native-families'))[1]!.dynamic
    if (absentFlags?.kind !== 'autogrow') throw new Error('expected autogrow')
    expect(absentFlags).toMatchObject({ materialization: 'wire15', template: [{ id: 'value' }] })
    expect(absentFlags.template[0]).not.toHaveProperty('forceInput')
    expect(absentFlags.template[0]).not.toHaveProperty('advanced')
    expect(absentFlags.template[0]!.widget).toEqual({ widgetType: 'INT', options: {} })
    expect(absentFlags.template[0]).not.toHaveProperty('ext')
    expect(outputsOf(decode('variables-everywhere'))[0]!.type).toEqual({
      kind: 'variable',
      templateId: 'T',
      allowedTypes: [{ kind: 'concrete', name: 'core.int' }, { kind: 'concrete', name: 'core.float' }],
    })
  })

  it('keeps ordinary top-level ids wire-14 lenient while structural segments stay strict', () => {
    // The [A-Za-z0-9_-]+ grammar is pinned for STRUCTURAL segments only.
    // Upstream emits plain input ids like "input_blocks.0." (ModelMerge*)
    // and output ids like "Audio VAE" (LTXVAudioVAELoader); those decode
    // verbatim, while the same characters in a construct id or nested
    // entry id still reject the whole node (bad-identifier,
    // nested-nonsegment-id fixtures below).
    const schema = decode('ordinary-nonsegment-ids')
    expect(inputsOf(schema).map((input) => input.id)).toEqual(['input_blocks.0.', 'time_embed.'])
    expect(outputsOf(schema).map((output) => output.id)).toEqual(['Audio VAE'])
    expect(inputsOf(schema)[0]).toMatchObject({ type: { kind: 'concrete', name: 'core.float' }, optional: false })
  })

  it('rejects every malformed recursive dynamic fixture as a whole node', () => {
    expect(Object.keys(fixture.invalid)).toEqual([
      'combo-key-leading-space',
      'combo-key-trailing-space',
      'combo-key-consecutive-spaces',
      'combo-key-empty',
      'combo-key-final-newline',
      'combo-default-case-mismatch',
      'variant-key-with-space',
      'member-name-with-space',
      'slot-both-discriminants',
      'slot-neither-discriminant',
      'variable-open-slot-type',
      'variable-variant-type',
      'open-slot-missing-required',
      'open-slot-required',
      'variant-slot-missing-required',
      'family-template-and-type',
      'bad-identifier',
      'nested-nonsegment-id',
      'bad-family-identifier',
      'bad-slot-identifier',
      'bad-output-family-identifier',
      'empty-template',
      'both-family-vocabularies',
      'names-min-over-capacity',
      'unknown-structural-kind',
      'legacy-variable-types-field',
      'non-string-concrete-name',
    ])
    for (const [name, wire] of Object.entries(fixture.invalid)) {
      const result = parseDinksterSchemaWire15(name, wire)
      expect(result.schema, name).toBeUndefined()
      expect(result.diagnostics.at(-1), name).toMatchObject({ severity: 'error', code: 'schema.parse.threw' })
    }
  })

  it.each([
    'combo-key-leading-space',
    'combo-key-trailing-space',
    'combo-key-consecutive-spaces',
    'combo-key-empty',
    'combo-key-final-newline',
  ] as const)('rejects malformed DynamicCombo option grammar: %s', (name) => {
    const result = parseDinksterSchemaWire15(name, fixture.invalid[name]!)
    expect(result.schema).toBeUndefined()
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'schema.parse.threw',
        message: `${name}: schema parse threw: interface[0].options[0].key must match [!-~]+( [!-~]+)*`,
      }),
    ])
  })

  it('matches DynamicCombo defaults by exact case-sensitive string', () => {
    const name = 'combo-default-case-mismatch'
    const result = parseDinksterSchemaWire15(name, fixture.invalid[name]!)
    expect(result.schema).toBeUndefined()
    expect(result.diagnostics.at(-1)?.message).toBe(
      `${name}: schema parse threw: interface[0].default must name an option`,
    )
  })

  it.each([
    ['DynamicSlot variant key', { role: 'dynamicSlot', id: 'slot', variants: [{ key: 'bad.key', type: { kind: 'concrete', types: ['core.int'] }, inputs: [] }], required: false }],
    ['construct id', { role: 'dynamicCombo', id: 'bad.id', options: [] }],
    ['nested entry id', { role: 'dynamicCombo', id: 'mode', options: [{ key: 'ok', inputs: [{ role: 'dynamicCombo', id: 'bad.id', options: [] }] }] }],
    ['template leaf id', { role: 'inputFamily', id: 'items', memberPrefix: 'item', template: [{ role: 'input', id: 'bad.leaf', type: { kind: 'concrete', types: ['core.int'] }, required: false }] }],
    ['memberPrefix', { role: 'inputFamily', id: 'items', memberPrefix: 'bad.prefix', template: [{ role: 'input', id: 'value', type: { kind: 'concrete', types: ['core.int'] }, required: false }] }],
    ['memberNames', { role: 'inputFamily', id: 'items', memberNames: ['bad.name'], template: [{ role: 'input', id: 'value', type: { kind: 'concrete', types: ['core.int'] }, required: false }] }],
  ] as const)('keeps %s on the strict segment grammar', (label, entry) => {
    const result = parseDinksterSchemaWire15(`strict-${label}`, { schemaVersion: 15, interface: [entry] })
    expect(result.schema).toBeUndefined()
    expect(result.diagnostics.at(-1)?.message).toContain('must match [A-Za-z0-9_-]+')
    expect(result.diagnostics.at(-1)?.message).not.toContain('[!-~]')
  })

  it('keeps DynamicSlot variant keys and memberNames on the strict segment grammar', () => {
    for (const name of ['variant-key-with-space', 'member-name-with-space'] as const) {
      const result = parseDinksterSchemaWire15(name, fixture.invalid[name]!)
      expect(result.schema, name).toBeUndefined()
      expect(result.diagnostics.at(-1)?.message, name).toContain('must match [A-Za-z0-9_-]+')
      expect(result.diagnostics.at(-1)?.message, name).not.toContain('[!-~]')
    }
  })

  it('detects duplicate DynamicCombo option keys by exact string', () => {
    const result = parseDinksterSchemaWire15('duplicate-punctuation-key', {
      schemaVersion: 15,
      interface: [{
        role: 'dynamicCombo', id: 'mode', options: [
          { key: 'Flux.2 [pro]', inputs: [] },
          { key: 'Flux.2 [pro]', inputs: [] },
        ],
      }],
    })
    expect(result.schema).toBeUndefined()
    expect(result.diagnostics.at(-1)?.message).toBe(
      "duplicate-punctuation-key: schema parse threw: interface[0] declares duplicate option key 'Flux.2 [pro]'",
    )
  })

  it.each([
    ['line feed', 'Flux.2 [pro]\n'],
    ['carriage return', 'Flux.2 [pro]\r'],
    ['carriage return plus line feed', 'Flux.2 [pro]\r\n'],
    ['line separator', 'Flux.2 [pro]\u2028'],
    ['paragraph separator', 'Flux.2 [pro]\u2029'],
    ['tab', 'Flux.2\t[pro]'],
    ['control', 'Flux.2\u0000[pro]'],
    ['non-ASCII', 'Flux.2 [pr\u00f6]'],
  ])('rejects DynamicCombo option keys containing %s with full consumption', (_label, key) => {
    const result = parseDinksterSchemaWire15('bad-option-character', {
      schemaVersion: 15,
      interface: [{ role: 'dynamicCombo', id: 'mode', options: [{ key, inputs: [] }] }],
    })
    expect(result.schema).toBeUndefined()
    expect(result.diagnostics.at(-1)?.message).toContain('must match [!-~]+( [!-~]+)*')
  })

  it.each([
    ['short key first', ['A', 'A].suffix']],
    ['long key first', ['A].suffix', 'A']],
  ])('rejects sibling option-key bracket aliasing with %s', (_label, keys) => {
    const result = parseDinksterSchemaWire15('aliased-option-keys', {
      schemaVersion: 15,
      interface: [{
        role: 'dynamicCombo', id: 'mode',
        options: keys.map((key) => ({ key, inputs: [] })),
      }],
    })
    expect(result.schema).toBeUndefined()
    expect(result.diagnostics.at(-1)?.message).toBe(
      "aliased-option-keys: schema parse threw: interface[0] option key 'A].suffix' aliases sibling key 'A'",
    )
  })

  it.each([
    ['short key first', ['A', 'A.suffix']],
    ['long key first', ['A.suffix', 'A']],
  ])('accepts ordinary sibling option-key prefixes with %s', (_label, keys) => {
    const result = parseDinksterSchemaWire15('ordinary-prefix-option-keys', {
      schemaVersion: 15,
      interface: [{
        role: 'dynamicCombo', id: 'mode',
        options: keys.map((key) => ({ key, inputs: [] })),
      }],
    })
    expect(result.diagnostics).toEqual([])
    expect(result.schema).toBeDefined()
  })

  it('enforces recursive depth and item budgets and keeps native families inert', () => {
    const ordinary = { role: 'input', id: 'leaf', type: { kind: 'concrete', types: ['core.int'] }, required: false }
    let atLimit: Record<string, unknown> = ordinary
    for (let depth = 0; depth < 16; depth++) {
      atLimit = { role: 'dynamicCombo', id: `combo_${depth}`, options: [{ key: 'next', inputs: [atLimit] }] }
    }
    expect(parseDinksterSchemaWire15('depth-ok', { schemaVersion: 15, interface: [atLimit] }).schema).toBeDefined()
    const overLimit = { role: 'dynamicCombo', id: 'outer', options: [{ key: 'next', inputs: [atLimit] }] }
    expect(parseDinksterSchemaWire15('depth-bad', { schemaVersion: 15, interface: [overLimit] }).schema).toBeUndefined()
    let terminalEmpty: Record<string, unknown> = { role: 'dynamicCombo', id: 'empty_0', options: [] }
    for (let depth = 1; depth <= 16; depth++) {
      terminalEmpty = { role: 'dynamicCombo', id: `empty_${depth}`, options: [{ key: 'next', inputs: [terminalEmpty] }] }
    }
    expect(parseDinksterSchemaWire15('depth-empty-bad', { schemaVersion: 15, interface: [terminalEmpty] }).schema).toBeUndefined()

    const nestedEntries = Array.from({ length: 513 }, (_, index) => ({
      role: 'input', id: `input_${index}`, type: { kind: 'concrete', types: ['core.int'] }, required: false,
    }))
    expect(parseDinksterSchemaWire15('budget-ok', { schemaVersion: 15, interface: [
      { role: 'dynamicCombo', id: 'many', options: [{ key: 'all', inputs: nestedEntries.slice(0, 512) }] },
    ] }).schema).toBeDefined()
    expect(parseDinksterSchemaWire15('budget-bad', { schemaVersion: 15, interface: [
      { role: 'dynamicCombo', id: 'many', options: [{ key: 'all', inputs: nestedEntries }] },
    ] }).schema).toBeUndefined()

    const native = decode('names-and-native-families')
    for (const state of [{ values: {}, dynamic: {} }, { values: {}, dynamic: { native: { members: ['m0'] } } }]) {
      const elaborated = elaborateInterface(native, state)
      // The prefix-less family materializes like any prefix family: one
      // min-filled or persisted member plus the trailing ghost affordance.
      const members = elaborated.items.filter(
        (item) => item.kind === 'input' && item.address.port === 'native.native',
      )
      expect(members).toHaveLength(2)
      expect(members.map((item) => item.kind === 'input' ? item.apiName : undefined)).toEqual(['native.native0', undefined])
    }
  })

  it('routes wire 15 through the live parser while retaining wire 14', () => {
    expect(DINKSTER_SCHEMA_WIRE_VERSION).toBe(44)
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS.at(-1)).toBe(44)
    const runtime = parseDinksterNodes({ schemaVersion: 15, nodes: fixture.valid })
    expect(runtime.schemas.size).toBe(Object.keys(fixture.valid).length)
    expect(runtime.diagnostics).toEqual([])
    const wire14 = parseDinksterNodes({ schemaVersion: 14, nodes: {
      family: { schemaVersion: 14, interface: [
        { role: 'inputFamily', id: 'items', type: { kind: 'concrete', types: ['core.int'] }, minMembers: 1, maxMembers: 3 },
      ] },
    } })
    expect(wire14.schemas.size).toBe(1)
    expect(wire14.diagnostics).toEqual([])
  })

  it('keeps wire-14 type families equivalent to wire-15 synthesized value templates', () => {
    const wire14 = parseDinksterNodes({ schemaVersion: 14, nodes: {
      family: { schemaVersion: 14, interface: [
        { role: 'inputFamily', id: 'items', type: { kind: 'concrete', types: ['core.int'] }, minMembers: 1, maxMembers: 3 },
      ] },
    } }).schemas.get('family')!
    const wire15 = parseDinksterNodes({ schemaVersion: 15, nodes: {
      family: { schemaVersion: 15, interface: [
        {
          role: 'inputFamily', id: 'items',
          template: [{ role: 'input', id: 'value', type: { kind: 'concrete', types: ['core.int'] }, required: false }],
          memberPrefix: 'items', minMembers: 1, maxMembers: 3, required: false,
        },
      ] },
    } }).schemas.get('family')!

    expect(inputsOf(wire15)[0]!.dynamic).toEqual(inputsOf(wire14)[0]!.dynamic)
    const state = { values: { 'items.items#m0': 7 }, dynamic: { items: { members: ['m0'] } } }
    expect(elaborateInterface(wire15, state)).toEqual(elaborateInterface(wire14, state))
  })

  it('materializes prefix members from document order with stable never-renumbered suffixes', () => {
    const schema = decode('prefix-family')
    expect(portsOf(schema, { values: {}, dynamic: { images: { members: ['m7', 'm2'] } } })).toEqual([
      ['images.m7', 'images.image0'],
      ['images.m2', 'images.image1'],
      ['images.m8', undefined],
    ])
    expect(portsOf(schema, { values: {}, dynamic: { images: { members: ['m2'] } } })).toEqual([
      ['images.m2', 'images.image0'],
      ['images.m3', undefined],
    ])
    expect(initialDynamicStateOf(schema)).toEqual({ images: { members: ['m0'], seq: 1 } })
    const fresh = elaborateInterface(schema, { values: {}, dynamic: initialDynamicStateOf(schema) })
    expect(fresh.diagnostics).toEqual([])
    expect(elabInputsOf(fresh).map((input) => input.address.port)).toEqual(['images.m0', 'images.m1'])
    expect(elabInputsOf(fresh)[1]).toMatchObject({
      origin: { kind: 'member', construct: 'images', ordinal: 1, ghost: true },
      materialize: [{ construct: 'images', members: ['m1'] }],
    })
    expect(elabInputsOf(fresh)[1]!.apiName).toBeUndefined()
  })

  it('materializes names families by semantic suffix and fills subset minimums', () => {
    const schema = decode('names-and-native-families')
    const selected = elaborateInterface(schema, { values: {}, dynamic: { channels: { members: ['right'] } } })
    expect(elabInputsOf(selected).map((input) => input.address.port)).toEqual([
      'channels.right', 'native.native', 'native.native',
    ])
    expect(elabInputsOf(selected).map((input) => input.apiName)).toEqual([
      'channels.right', 'native.native0', undefined,
    ])
    expect(selected.diagnostics).toEqual([])
    expect(initialDynamicStateOf(schema)).toEqual({ channels: { members: ['left'] } })
    expect(elaborateInterface(schema, { values: {}, dynamic: {} }).diagnostics).toEqual([])
    expect(elaborateInterface(schema, { values: {}, dynamic: { channels: { members: ['other'] } } }).diagnostics.map((d) => d.code)).toContain('elab.autogrow.unknownName')
    const mixed = elaborateInterface(schema, {
      values: {}, dynamic: { channels: { members: ['right', 'other'] } },
    })
    expect(elabInputsOf(mixed).map((input) => input.address.port)).toEqual([
      'channels.right', 'native.native', 'native.native',
    ])
    expect(mixed.diagnostics.map((diagnostic) => diagnostic.code)).toContain('elab.autogrow.unknownName')
  })

  it('fills named-family minimums after retained members without rewinding the ghost', () => {
    const schema = parseDinksterSchemaWire15('named-minimums', {
      schemaVersion: 15,
      interface: [{
        role: 'inputFamily', id: 'values', memberNames: ['a', 'b', 'c', 'd'], minMembers: 2,
        template: [{
          role: 'input', id: 'value',
          type: { kind: 'concrete', types: ['core.number'] }, required: false,
        }],
      }],
    }).schema!

    const retained = elaborateInterface(schema, {
      values: {}, dynamic: { values: { members: ['b'] } },
    })
    expect(retained.diagnostics).toEqual([])
    expect(elabInputsOf(retained).map((input) => [input.address.port, input.origin])).toEqual([
      ['values.b', { kind: 'member', construct: 'values', ordinal: 1, wire15Naming: 'names' }],
      ['values.c', { kind: 'member', construct: 'values', ordinal: 2, wire15Naming: 'names' }],
      ['values.d', { kind: 'member', construct: 'values', ordinal: 3, wire15Naming: 'names', ghost: true }],
    ])

    expect(portsOf(schema, {
      values: {}, dynamic: { values: { members: ['c', 'b'] } },
    })).toEqual([
      ['values.b', 'values.b'],
      ['values.c', 'values.c'],
      ['values.d', undefined],
    ])

    const exhausted = elaborateInterface(schema, {
      values: {}, dynamic: { values: { members: ['d'] } },
    })
    expect(exhausted.diagnostics).toEqual([])
    expect(elabInputsOf(exhausted).map((input) => [input.address.port, input.origin])).toEqual([
      ['values.a', { kind: 'member', construct: 'values', ordinal: 0, wire15Naming: 'names' }],
      ['values.d', { kind: 'member', construct: 'values', ordinal: 3, wire15Naming: 'names' }],
    ])
  })

  it('materializes effective combo choices through combo-in-combo and family-in-combo paths', () => {
    const schema = decode('recursive-combos')
    const absent = elaborateInterface(schema, { values: {}, dynamic: { 'mode.quality': { selected: 'gone' } } })
    expect(elabInputsOf(absent).map((input) => input.address.port)).toEqual(['mode', 'zero'])
    expect(absent.diagnostics).toEqual([])

    const active = elaborateInterface(schema, {
      values: {},
      dynamic: {
        mode: { selected: 'batch' },
        'mode.frames': { members: ['stable'] },
        'mode.quality': { selected: 'full' },
      },
    })
    expect(elabInputsOf(active).map((input) => input.address.port)).toEqual([
      'mode',
      'mode.frames.stable',
      'mode.frames.m0',
      'mode.quality',
      'mode.quality.steps',
      'zero',
    ])
    expect(elabInputsOf(active).map((input) => input.apiName)).toEqual([
      'mode',
      'mode.frames.image0',
      undefined,
      'mode.quality',
      'mode.quality.steps',
      'zero',
    ])
    expect(elabInputsOf(active).every((input) => !input.address.port.includes('[batch]') && !input.address.port.includes('[full]'))).toBe(true)
  })

  it('discovers family membership from nested choice state and appends grouped leaf ids', () => {
    const schema = parseDinksterSchemaWire15('choice-family', {
      schemaVersion: 15,
      interface: [{
        role: 'inputFamily', id: 'rows', memberPrefix: 'row', minMembers: 1, maxMembers: 3,
        template: [{ role: 'dynamicCombo', id: 'mode', options: [{ key: 'on', inputs: [
          { role: 'input', id: 'left', type: { kind: 'concrete', types: ['core.int'] }, required: false },
          { role: 'input', id: 'right', type: { kind: 'concrete', types: ['core.int'] }, required: false },
        ] }] }],
      }],
    }).schema!
    const materialized = elaborateInterface(schema, { values: {}, dynamic: { 'rows.stable.mode': { selected: 'on' } } })
    expect(elabInputsOf(materialized).map((input) => input.address.port)).toEqual([
      'rows.stable.mode',
      'rows.stable.mode.left',
      'rows.stable.mode.right',
      'rows.m0.mode',
      'rows.m0.mode.left',
      'rows.m0.mode.right',
    ])

    const implicitDescendant = elaborateInterface(schema, {
      values: { 'rows.stale.mode.left': 1 },
      dynamic: { 'rows.stale.mode.child': { selected: 'ignored' } },
    })
    expect(elabInputsOf(implicitDescendant).map((input) => input.address.port)).toEqual([
      'rows.stale.mode',
      'rows.stale.mode.left',
      'rows.stale.mode.right',
      'rows.m0.mode',
      'rows.m0.mode.left',
      'rows.m0.mode.right',
    ])
    expect(implicitDescendant.diagnostics).toEqual([])
  })

  it('discovers family members from stored values, links, and recursively reachable state', () => {
    const prefix = decode('prefix-family')
    expect(portsOf(prefix, { values: { 'images.stored': 1 }, dynamic: {} })).toEqual([
      ['images.stored', 'images.image0'],
      ['images.m0', undefined],
    ])
    expect(portsOf(prefix, { values: {}, dynamic: {} }, connected('images.linked'))).toEqual([
      ['images.linked', 'images.image0'],
      ['images.m0', undefined],
    ])

    const grouped = parseDinksterSchemaWire15('nested-evidence', {
      schemaVersion: 15,
      interface: [{
        role: 'inputFamily', id: 'rows', memberPrefix: 'row', minMembers: 0,
        template: [{
          role: 'inputFamily', id: 'cells', memberPrefix: 'cell', minMembers: 0,
          template: [{ role: 'input', id: 'value', type: { kind: 'concrete', types: ['core.int'] }, required: false }],
        }],
      }],
    }).schema!
    expect(portsOf(grouped, { values: { 'rows.outer.cells.inner': 3 }, dynamic: {} })).toEqual([
      ['rows.outer.cells.inner', 'rows.row0.cells.cell0'],
      ['rows.outer.cells.m0', undefined],
    ])
  })

  it('reports malformed selectors that imply family membership', () => {
    const schema = parseDinksterSchemaWire15('choice-family-errors', {
      schemaVersion: 15,
      interface: [{
        role: 'inputFamily', id: 'rows', memberPrefix: 'row', minMembers: 0,
        template: [{ role: 'dynamicCombo', id: 'mode', options: [{ key: 'on', inputs: [] }] }],
      }],
    }).schema!
    for (const selected of [7, 'gone']) {
      const result = elaborateInterface(
        schema,
        { values: {}, dynamic: { 'rows.member.mode': { selected } } } as never,
        undefined,
        { nodeId: asNodeId('n1') },
      )
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: 'prompt.bad_dynamic_choice',
          anchor: { port: { node: 'n1', port: 'rows.member.mode' } },
        }),
      ])
    }
  })

  it('keeps nested and names-form value leaves on wire-15 dot-scoped materialization', () => {
    const nested = decode('grouped-and-nested-families')
    expect(portsOf(nested, {
      values: {},
      dynamic: {
        outer: { members: ['root'] },
        'outer.root.inner': { members: ['child'] },
      },
    })).toEqual([
      ['pairs.m0.image', undefined],
      ['pairs.m0.mask', undefined],
      ['outer.root.inner.child', 'outer.row0.inner.sub0'],
      ['outer.root.inner.m0', undefined],
    ])

    const namesValue = parseDinksterSchemaWire15('names-value', {
      schemaVersion: 15,
      interface: [{
        role: 'inputFamily', id: 'values', memberNames: ['a', 'b'], minMembers: 0,
        template: [{ role: 'input', id: 'value', type: { kind: 'concrete', types: ['core.string'] }, required: false }],
      }],
    }).schema!
    expect(portsOf(namesValue, { values: {}, dynamic: { values: { members: ['b'] } } })).toEqual([
      ['values.b', 'values.b'],
    ])
  })

  it('rejects malformed active choices with node-and-input anchors while fresh choices materialize', () => {
    const schema = decode('recursive-combos')
    for (const selected of [7, 'gone']) {
      const result = elaborateInterface(
        schema,
        { values: {}, dynamic: { mode: { selected } } } as never,
        undefined,
        { nodeId: asNodeId('n1') },
      )
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          severity: 'error', code: 'prompt.bad_dynamic_choice',
          anchor: { port: { node: 'n1', port: 'mode' } },
        }),
      ])
    }
    const fresh = elaborateInterface(schema, { values: {}, dynamic: {} })
    expect(elabInputsOf(fresh).map((input) => input.address.port)).toEqual(['mode', 'zero'])
    expect(elabInputsOf(fresh)[0]).toMatchObject({
      derivedValue: 'none',
      origin: { kind: 'selector', construct: 'mode' },
    })
    expect(elabInputsOf(fresh)[1]).toMatchObject({
      origin: { kind: 'selector', construct: 'zero' },
    })
    expect(elabInputsOf(fresh)[1]?.derivedValue).toBeUndefined()
    expect(fresh.submissionValues).toEqual([])
  })

  it('materializes open slots from stored values or links and rejects inactive dependents', () => {
    const schema = decode('open-slot')
    expect(portsOf(schema, { values: {}, dynamic: {} })).toEqual([['model', 'model']])
    expect(portsOf(schema, { values: { model: 'stored' }, dynamic: {} })).toEqual([
      ['model', 'model'], ['model.weight', 'model.weight'],
    ])
    expect(portsOf(schema, { values: {}, dynamic: {} }, connected('model'))).toEqual([
      ['model', 'model'], ['model.weight', 'model.weight'],
    ])
    const inactive = elaborateInterface(schema, { values: { 'model.weight': 0.5 }, dynamic: {} })
    expect(inactive.diagnostics.map((d) => d.code)).toContain('compile.value.unknownInput')

    const nested = parseDinksterSchemaWire15('nested-open-slot', {
      schemaVersion: 15,
      interface: [{
        role: 'inputFamily', id: 'rows', memberPrefix: 'row', minMembers: 0,
        template: [{
          role: 'dynamicSlot', id: 'model', slotType: { kind: 'concrete', types: ['core.string'] }, required: false,
          inputs: [{ role: 'input', id: 'weight', type: { kind: 'concrete', types: ['core.float'] }, required: false }],
        }],
      }],
    }).schema!
    expect(elaborateInterface(nested, { values: { 'rows.m.model.weight': 0.5 }, dynamic: {} }).diagnostics.map((d) => d.code)).toContain('compile.value.unknownInput')
    expect(elaborateInterface(nested, { values: {}, dynamic: {} }, connected('rows.m.model.weight')).diagnostics.map((d) => d.code)).toContain('compile.value.unknownInput')
    expect(elaborateInterface(nested, { values: {}, dynamic: { 'rows.m.model.choice': { selected: 'stale' } } }).diagnostics.map((d) => d.code)).toContain('compile.value.unknownInput')
  })

  it('keeps variant slots choice-driven and option keys out of materialized ids', () => {
    const schema = decode('variant-slot')
    expect(elabInputsOf(elaborateInterface(schema, { values: {}, dynamic: {} }))).toEqual([])
    expect(portsOf(schema, { values: {}, dynamic: { source: { selected: 'mask' } } })).toEqual([
      ['source', 'source'],
      ['source.strength', 'source.strength'],
      ['source.invert', 'source.invert'],
    ])
  })

  it('rejects active projected-namespace collisions and materialization budget overflow', () => {
    const collision = parseDinksterSchemaWire15('collision', {
      schemaVersion: 15,
      interface: [
        { role: 'input', id: 'items.item0', type: { kind: 'concrete', types: ['core.int'] }, required: false },
        {
          role: 'inputFamily', id: 'items', memberPrefix: 'item', maxMembers: 2,
          template: [{ role: 'input', id: 'leaf', type: { kind: 'concrete', types: ['core.int'] }, required: false }],
        },
      ],
    }).schema!
    expect(elaborateInterface(collision, { values: {}, dynamic: { items: { members: ['stable'] } } }).diagnostics.map((d) => d.code)).toContain('elab.projectedNamespaceCollision')

    const selectorCollision = parseDinksterSchemaWire15('selector-collision', {
      schemaVersion: 15,
      interface: [
        { role: 'input', id: 'mode.quality', type: { kind: 'concrete', types: ['core.int'] }, required: false },
        { role: 'dynamicCombo', id: 'mode', options: [{ key: 'on', inputs: [
          { role: 'dynamicCombo', id: 'quality', options: [{ key: 'full', inputs: [] }] },
        ] }] },
      ],
    }).schema!
    expect(elaborateInterface(selectorCollision, {
      values: {}, dynamic: { mode: { selected: 'on' }, 'mode.quality': { selected: 'full' } },
    }).diagnostics.map((d) => d.code)).toContain('elab.projectedNamespaceCollision')

    const projectedSelectorCollision = parseDinksterSchemaWire15('projected-selector-collision', {
      schemaVersion: 15,
      interface: [
        { role: 'input', id: 'rows.row0.mode', type: { kind: 'concrete', types: ['core.int'] }, required: false },
        {
          role: 'inputFamily', id: 'rows', memberPrefix: 'row', minMembers: 0, maxMembers: 2,
          template: [{ role: 'dynamicCombo', id: 'mode', options: [{ key: 'on', inputs: [] }] }],
        },
      ],
    }).schema!
    expect(elaborateInterface(projectedSelectorCollision, {
      values: {}, dynamic: { rows: { members: ['stable'] }, 'rows.stable.mode': { selected: 'on' } },
    }).diagnostics.map((d) => d.code)).toContain('elab.projectedNamespaceCollision')

    const budget = parseDinksterSchemaWire15('budget', {
      schemaVersion: 15,
      interface: [{
        role: 'inputFamily', id: 'items', memberPrefix: 'item', maxMembers: 600,
        template: [{ role: 'input', id: 'leaf', type: { kind: 'concrete', types: ['core.int'] }, required: false }],
      }],
    }).schema!
    const members = Array.from({ length: 513 }, (_, index) => `m${index}`)
    expect(elaborateInterface(budget, { values: {}, dynamic: { items: { members } } }).diagnostics.map((d) => d.code)).toContain('elab.autogrow.overMax')
    expect(elaborateInterface(budget, { values: {}, dynamic: { items: { members: Array(513).fill('same') } } }).diagnostics.map((d) => d.code)).toContain('elab.autogrow.overMax')
  })

  it('keeps wire-14 elaboration unchanged by wire-15 evidence limits', () => {
    const schema = parseDinksterNodes({
      schemaVersion: 14,
      nodes: { family: { displayName: 'Family', category: 'test', input: {}, inputFamily: { items: { type: 'INT', min: 0, max: 2 } }, output: [] } },
    }).schemas.get('family')!
    const values = Object.fromEntries(Array.from({ length: 1025 }, (_, index) => [`irrelevant.${index}`, index]))
    const result = elaborateInterface(schema, { values, dynamic: {} })
    expect(elabInputsOf(result)).toEqual(elabInputsOf(elaborateInterface(schema, { values: {}, dynamic: {} })))
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('elab.budget.items')
  })

  it('exposes effective wire-15 selector state for submission lowering', () => {
    const fresh = elaborateInterface(decode('recursive-combos'), { values: {}, dynamic: {} })
    expect(fresh.diagnostics).toEqual([])
    expect(elabInputsOf(fresh)[0]).toMatchObject({
      address: { port: 'mode' },
      derivedValue: 'none',
      wire15Materialization: true,
    })

    const result = elaborateInterface(
      decode('recursive-combos'),
      { values: {}, dynamic: { mode: { selected: 'batch' }, 'mode.quality': { selected: 'full' } } },
    )
    expect(result.diagnostics).toEqual([])
    expect(elabInputsOf(result).filter((input) => input.origin.kind === 'selector' && input.derivedValue !== undefined)).toMatchObject([
      { address: { port: 'mode' }, derivedValue: 'batch', wire15Materialization: true },
      { address: { port: 'mode.quality' }, derivedValue: 'full', wire15Materialization: true },
    ])
    expect(result.submissionValues).toEqual([])
  })
})
