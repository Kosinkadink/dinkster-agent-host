import { describe, expect, it } from 'vitest'
import { elaborateInterface, type Connectivity } from '../src/schema/elaborate.js'
import { parseObjectInfoEntry, type ObjectInfoEntry } from '../src/schema/object-info.js'
import { inputsOf, outputsOf } from '../src/schema/model.js'

describe('parseObjectInfoEntry', () => {
  it('translates exact multiselect declarations and refuses malformed lookalikes', () => {
    const valid = parseObjectInfoEntry('Multi', {
      input: { required: { providers: ['COMBO', {
        multiselect: true,
        options: ['beta', 'alpha', 'beta'],
        multi_select: { placeholder: 'Pick', chip: false },
        default: ['beta', 'alpha', 'beta'],
        forceInput: true,
        lazy: true,
        advanced: true,
        display_name: 'Providers',
        tooltip: 'Select providers',
      }] } },
      output: ['STRING'],
    })
    expect(valid.diagnostics).toEqual([])
    expect(inputsOf(valid.schema!)[0]).toMatchObject({
      type: { kind: 'list', element: { kind: 'concrete', name: 'core.combo' } },
      widget: {
        widgetType: 'MULTI_COMBO',
        options: { options: ['beta', 'alpha', 'beta'], placeholder: 'Pick', chip: false },
        default: ['beta', 'alpha', 'beta'],
      },
      forceInput: true,
      lazy: true,
      advanced: true,
      displayName: 'Providers',
      tooltip: 'Select providers',
    })
    expect(outputsOf(valid.schema!)[0]!.type).toEqual({ kind: 'concrete', name: 'STRING' })

    const legacy = parseObjectInfoEntry('LegacyMulti', {
      input: { required: { providers: [['a', 'b'], {
        multiselect: true, multi_select: {}, default: ['b'],
      }] } },
      output: [],
    })
    expect(inputsOf(legacy.schema!)[0]).toMatchObject({
      type: { kind: 'list', element: { kind: 'concrete', name: 'core.combo' } },
      widget: { widgetType: 'MULTI_COMBO', options: { options: ['a', 'b'] }, default: ['b'] },
    })

    const intrinsic = parseObjectInfoEntry('IntrinsicMulti', {
      input: { required: { providers: [['a'], { multiselect: true, multi_select: {} }] } },
      output: [],
    })
    expect(inputsOf(intrinsic.schema!)[0]!.widget?.default).toBeUndefined()

    for (const [name, wire, inputIsList] of [
      ['missing config', [['a'], { multiselect: true, default: ['a'] }], false],
      ['missing flag', [['a'], { multi_select: {}, default: ['a'] }], false],
      ['scalar default', [['a'], { multiselect: true, multi_select: {}, default: 'a' }], false],
      ['numeric option', [['a', 1], { multiselect: true, multi_select: {}, default: ['a'] }], false],
      ['empty option', [[''], { multiselect: true, multi_select: {}, default: [] }], false],
      ['malformed remote route', [['a'], { multiselect: true, multi_select: {}, default: [], remote: { route: '/models' } }], false],
      ['malformed remote policy', [['a'], { multiselect: true, multi_select: {}, default: [], remote: {
        route: '/api/choices/models', refresh_button: true, max_retries: 6,
      } }], false],
      ['refresh policy without button', [['a'], { multiselect: true, multi_select: {}, default: [], remote: {
        route: '/api/choices/models', refresh_button: false, control_after_refresh: 'first',
      } }], false],
      ['last refresh policy without button', [['a'], { multiselect: true, multi_select: {}, default: [], remote: {
        route: '/api/choices/models', refresh_button: false, control_after_refresh: 'last',
      } }], false],
      ['controller', [['a'], { multiselect: true, multi_select: {}, default: ['a'], control_after_generate: true }], false],
      ['class list conflict', [['a'], { multiselect: true, multi_select: {}, default: ['a'] }], true],
    ] as const) {
      expect(() => parseObjectInfoEntry(name, {
        input: { required: { providers: wire as never } }, output: [], is_input_list: inputIsList,
      })).toThrow()
    }
  })

  it('parses a classic V1-shaped node (KSampler-like)', () => {
    const { schema, diagnostics } = parseObjectInfoEntry('KSampler', {
      input: {
        required: {
          model: ['MODEL', {}],
          seed: ['INT', { default: 0, min: 0, max: 18446744073709551615, control_after_generate: true }],
          steps: ['INT', { default: 20, min: 1, max: 10000 }],
          sampler_name: [['euler', 'euler_a', 'ddim'], {}],
        },
        optional: {},
      },
      input_order: { required: ['model', 'seed', 'steps', 'sampler_name'], optional: [] },
      output: ['LATENT'],
      output_is_list: [false],
      output_name: ['LATENT'],
      name: 'KSampler',
      display_name: 'KSampler',
      category: 'sampling',
      output_node: false,
    })
    expect(diagnostics).toEqual([])
    expect(schema).toBeDefined()
    const inputs = inputsOf(schema!)
    expect(inputs.map((i) => i.id)).toEqual(['model', 'seed', 'steps', 'sampler_name'])

    const model = inputs[0]!
    expect(model.type).toEqual({ kind: 'concrete', name: 'MODEL' })
    expect(model.widget).toBeUndefined()

    const seed = inputs[1]!
    expect(seed.widget?.widgetType).toBe('INT')
    expect(seed.widget?.controller).toBe('after_generate')

    const combo = inputs[3]!
    expect(combo.widget?.widgetType).toBe('COMBO')
    expect(combo.widget?.options['options']).toEqual(['euler', 'euler_a', 'ddim'])
    expect(combo.widget?.default).toBe('euler')

    const outputs = outputsOf(schema!)
    expect(outputs).toHaveLength(1)
    expect(outputs[0]!.id).toBe('out0')
    expect(outputs[0]!.type).toEqual({ kind: 'concrete', name: 'LATENT' })
  })

  it('uses the first legacy combo value as its implicit schema default', () => {
    const { schema, diagnostics } = parseObjectInfoEntry('Combos', {
      input: { required: {
        labelled: [[[2, 'two'], [3, 'three']], {}],
        explicit: [['a', 'b'], { default: 'b' }],
        empty: [[], {}],
      } },
      input_order: { required: ['labelled', 'explicit', 'empty'] },
      output: [],
    })
    expect(diagnostics).toEqual([])
    const [labelled, explicit, empty] = inputsOf(schema!)
    expect(labelled!.widget?.default).toBe(2)
    expect(explicit!.widget?.default).toBe('b')
    expect(empty!.widget?.default).toBeUndefined()
  })

  it('parses V3 MultiType and MatchType', () => {
    const { schema } = parseObjectInfoEntry('PolyNode', {
      input: {
        required: {
          either: ['IMAGE,MASK', {}],
          matched: ['COMFY_MATCHTYPE_V3', { template: { template_id: 'T', allowed_types: 'IMAGE,LATENT' } }],
          anything: ['*', {}],
        },
      },
      input_order: { required: ['either', 'matched', 'anything'] },
      output: ['COMFY_MATCHTYPE_V3'],
      output_matchtypes: ['T'],
      output_name: ['matched'],
      name: 'PolyNode',
    })
    const [either, matched, anything] = inputsOf(schema!)
    expect(either!.type).toEqual({ kind: 'union', names: ['IMAGE', 'MASK'] })
    expect(matched!.type).toEqual({
      kind: 'variable',
      templateId: 'T',
      allowedTypes: [
        { kind: 'concrete', name: 'IMAGE' },
        { kind: 'concrete', name: 'LATENT' },
      ],
    })
    expect(anything!.type).toEqual({ kind: 'wildcard' })
    const [out] = outputsOf(schema!)
    expect(out!.type).toEqual({ kind: 'variable', templateId: 'T' })
  })

  it('maps ComfyUI COLOR inputs and supplies the compatibility default', () => {
    const { schema, diagnostics } = parseObjectInfoEntry('Colors', {
      input: { required: {
        explicit: ['COLOR', { default: '#00ff3380' }],
        fallback: ['COLOR', {}],
      } },
      input_order: { required: ['explicit', 'fallback'] },
      output: [],
    })
    expect(diagnostics).toEqual([])
    const [explicit, fallback] = inputsOf(schema!)
    expect(explicit!.widget).toEqual({ widgetType: 'COLOR', options: {}, default: '#00ff3380' })
    expect(fallback!.widget).toEqual({ widgetType: 'COLOR', options: {}, default: '#ffffff' })
  })

  it('parses an Autogrow dynamic input', () => {
    const { schema, diagnostics } = parseObjectInfoEntry('Grower', {
      input: {
        optional: {
          images: [
            'COMFY_AUTOGROW_V3',
            {
              template: {
                input: { required: { image: ['IMAGE', {}] } },
                prefix: 'image',
                min: 1,
                max: 8,
              },
            },
          ],
        },
      },
      output: [],
      name: 'Grower',
    })
    expect(diagnostics).toEqual([])
    const [images] = inputsOf(schema!)
    expect(images!.dynamic?.kind).toBe('autogrow')
    if (images!.dynamic?.kind === 'autogrow') {
      expect(images!.dynamic.template).toHaveLength(1)
      expect(images!.dynamic.template[0]!.type).toEqual({ kind: 'concrete', name: 'IMAGE' })
      expect(images!.dynamic.naming).toEqual({ kind: 'prefix', prefix: 'image', min: 1, max: 8 })
    }
  })

  it('preserves display names and tooltips on dynamic constructs', () => {
    const { schema, diagnostics } = parseObjectInfoEntry('DynamicPresentation', {
      input: { required: {
        mode: ['COMFY_DYNAMICCOMBO_V3', {
          display_name: 'Sampling Mode',
          tooltip: 'Select a sampling strategy.',
          options: [{ key: 'plain', inputs: { required: {} } }],
        }],
        rows: ['COMFY_AUTOGROW_V3', {
          display_name: 'Image Rows',
          tooltip: 'Add images.',
          template: { input: { required: { image: ['IMAGE', {}] } }, prefix: 'image' },
        }],
        source: ['COMFY_DYNAMICSLOT_V3', {
          display_name: 'Source Model',
          tooltip: 'Connect a model.',
          slotType: 'MODEL',
          inputs: {},
        }],
      } },
      output: [],
    })
    expect(diagnostics).toEqual([])
    expect(inputsOf(schema!).map((item) => ({
      id: item.id,
      displayName: item.displayName,
      tooltip: item.tooltip,
      kind: item.dynamic?.kind,
    }))).toEqual([
      { id: 'mode', displayName: 'Sampling Mode', tooltip: 'Select a sampling strategy.', kind: 'dynamicCombo' },
      { id: 'rows', displayName: 'Image Rows', tooltip: 'Add images.', kind: 'autogrow' },
      { id: 'source', displayName: 'Source Model', tooltip: 'Connect a model.', kind: 'dynamicSlot' },
    ])
  })

  it('parses a grouped autogrow template, preserving declared slot order and optionality', () => {
    const { schema, diagnostics } = parseObjectInfoEntry('GroupGrower', {
      input: {
        optional: {
          items: [
            'COMFY_AUTOGROW_V3',
            {
              template: {
                input: {
                  required: { image: ['IMAGE', {}] },
                  optional: { mask: ['MASK', {}] },
                },
                prefix: 'item',
                min: 1,
                max: 4,
              },
            },
          ],
        },
      },
      output: [],
      name: 'GroupGrower',
    })
    expect(diagnostics).toEqual([])
    const [items] = inputsOf(schema!)
    expect(items!.dynamic?.kind).toBe('autogrow')
    if (items!.dynamic?.kind === 'autogrow') {
      expect(items!.dynamic.template.map((s) => [s.id, s.optional])).toEqual([
        ['image', false],
        ['mask', true],
      ])
    }
  })

  it('recursively parses an autogrow template containing an autogrow', () => {
    const { schema, diagnostics } = parseObjectInfoEntry('NestedGrower', {
      input: { required: { outer: ['COMFY_AUTOGROW_V3', { template: {
        input: { required: { inner: ['COMFY_AUTOGROW_V3', { template: {
          input: { optional: { value: ['INT', { min: 1, max: 9, forceInput: true }] } }, prefix: 'value', min: 1,
        } }] } }, prefix: 'outer', min: 1,
      } }] } }, output: [],
    })
    expect(diagnostics).toEqual([])
    const outer = inputsOf(schema!)[0]!
    expect(outer.dynamic?.kind).toBe('autogrow')
    if (outer.dynamic?.kind !== 'autogrow') return
    const inner = outer.dynamic.template[0]!
    expect(inner.dynamic?.kind).toBe('autogrow')
    if (inner.dynamic?.kind !== 'autogrow') return
    expect(inner.dynamic.template[0]).toMatchObject({
      id: 'value', optional: true, forceInput: true,
      widget: { widgetType: 'INT', options: { min: 1, max: 9 } },
    })
  })

  it('recursively parses an autogrow template containing a DynamicCombo', () => {
    const { schema, diagnostics } = parseObjectInfoEntry('GrowCombo', {
      input: { required: { rows: ['COMFY_AUTOGROW_V3', { template: {
        input: { required: { mode: ['COMFY_DYNAMICCOMBO_V3', { options: [
          { key: 'full', inputs: { required: { strength: ['FLOAT', { default: 0.5 }] } } },
        ] }] } }, prefix: 'row', min: 1,
      } }] } }, output: [],
    })
    expect(diagnostics).toEqual([])
    const rows = inputsOf(schema!)[0]!
    if (rows.dynamic?.kind !== 'autogrow') throw new Error('expected autogrow')
    expect(rows.dynamic.template[0]!.dynamic?.kind).toBe('dynamicCombo')
  })

  it('recursively parses an autogrow inside a DynamicCombo branch', () => {
    const { schema, diagnostics } = parseObjectInfoEntry('ComboGrow', {
      input: { required: { mode: ['COMFY_DYNAMICCOMBO_V3', { options: [
        { key: 'many', inputs: { optional: { images: ['COMFY_AUTOGROW_V3', { template: {
          input: { required: { image: ['IMAGE', {}] } }, prefix: 'image', max: 4,
        } }] } } },
      ] }] } }, output: [],
    })
    expect(diagnostics).toEqual([])
    const mode = inputsOf(schema!)[0]!
    if (mode.dynamic?.kind !== 'dynamicCombo') throw new Error('expected combo')
    expect(mode.dynamic.options[0]!.inputs[0]!.dynamic?.kind).toBe('autogrow')
  })

  it('recursively parses a DynamicCombo in DynamicSlot dependents', () => {
    const { schema, diagnostics } = parseObjectInfoEntry('SlotCombo', {
      input: { optional: { source: ['COMFY_DYNAMICSLOT_V3', { slotType: 'IMAGE', inputs: {
        required: { mode: ['COMFY_DYNAMICCOMBO_V3', { options: [
          { key: 'blur', inputs: { required: { radius: ['INT', { default: 2 }] } } },
        ] }] },
      } }] } }, output: [],
    })
    expect(diagnostics).toEqual([])
    const source = inputsOf(schema!)[0]!
    if (source.dynamic?.kind !== 'dynamicSlot') throw new Error('expected slot')
    expect(source.dynamic.inputs[0]!.dynamic?.kind).toBe('dynamicCombo')
  })

  it('parses DynamicSlot variants with types, inputs, and widget metadata', () => {
    const { schema, diagnostics } = parseObjectInfoEntry('SpecializedSlot', {
      input: { optional: { slot: ['COMFY_DYNAMICSLOT_V3', {
        slotType: 'MODEL',
        inputs: { required: { shared: ['CLIP', {}] } },
        variants: [
          { key: 'lora', type: 'LORA', inputs: { required: { weight: ['FLOAT', { default: 0.75, min: 0 }] } } },
          { key: 'plain', type: 'MODEL,CLIP', inputs: { optional: { note: ['STRING', { default: 'ok' }] } } },
        ],
      }] } }, output: [],
    })
    expect(diagnostics).toEqual([])
    const slot = inputsOf(schema!)[0]!
    if (slot.dynamic?.kind !== 'dynamicSlot') throw new Error('expected slot')
    expect(slot.dynamic.variants).toEqual([
      {
        key: 'lora', type: { kind: 'concrete', name: 'LORA' },
        inputs: [expect.objectContaining({ id: 'weight', type: { kind: 'concrete', name: 'FLOAT' }, widget: { widgetType: 'FLOAT', options: { min: 0 }, default: 0.75 } })],
      },
      {
        key: 'plain', type: { kind: 'union', names: ['MODEL', 'CLIP'] },
        inputs: [expect.objectContaining({ id: 'note', optional: true, widget: { widgetType: 'STRING', options: {}, default: 'ok' } })],
      },
    ])
  })

  // 'Image' is legal under the settled [A-Za-z0-9_-]+ grammar (c2ac572);
  // dots and spaces are not (the key rides bracket paths and slotVariants).
  it.each(['a.b', 'has space'])('drops invalid DynamicSlot variant key %s while preserving valid siblings', (badKey) => {
    const { schema, diagnostics } = parseObjectInfoEntry('BadVariant', {
      input: { required: { slot: ['COMFY_DYNAMICSLOT_V3', { slotType: 'IMAGE', variants: [
        { key: badKey, type: 'MASK', inputs: { required: { bad: ['INT', {}] } } },
        { key: 'valid-key', type: 'IMAGE', inputs: { required: { good: ['FLOAT', {}] } } },
      ] }] } }, output: [],
    })
    const slot = inputsOf(schema!)[0]!
    if (slot.dynamic?.kind !== 'dynamicSlot') throw new Error('expected slot')
    expect(diagnostics.filter((d) => d.code === 'schema.slot.badVariantKey')).toHaveLength(1)
    expect(slot.dynamic.variants?.map((v) => v.key)).toEqual(['valid-key'])
  })

  it('drops a duplicate DynamicSlot variant key and keeps its first definition', () => {
    const { schema, diagnostics } = parseObjectInfoEntry('DuplicateVariant', {
      input: { required: { slot: ['COMFY_DYNAMICSLOT_V3', { slotType: 'IMAGE', variants: [
        { key: 'mask', type: 'MASK', inputs: { required: { first: ['INT', {}] } } },
        { key: 'mask', type: 'IMAGE', inputs: { required: { second: ['FLOAT', {}] } } },
      ] }] } }, output: [],
    })
    const slot = inputsOf(schema!)[0]!
    if (slot.dynamic?.kind !== 'dynamicSlot') throw new Error('expected slot')
    expect(diagnostics.filter((d) => d.code === 'schema.slot.duplicateVariantKey')).toHaveLength(1)
    expect(slot.dynamic.variants).toEqual([
      expect.objectContaining({ key: 'mask', type: { kind: 'concrete', name: 'MASK' }, inputs: [expect.objectContaining({ id: 'first' })] }),
    ])
  })

  it('parses an autogrow nested inside DynamicSlot variant inputs', () => {
    const { schema, diagnostics } = parseObjectInfoEntry('VariantGrow', {
      input: { required: { slot: ['COMFY_DYNAMICSLOT_V3', { slotType: 'IMAGE', variants: [{
        key: 'batch', type: 'IMAGE', inputs: { required: { rows: ['COMFY_AUTOGROW_V3', { template: {
          input: { required: { image: ['IMAGE', {}] }, optional: { amount: ['INT', { default: 1 }] } }, prefix: 'row', min: 1,
        } }] } },
      }] }] } }, output: [],
    })
    expect(diagnostics).toEqual([])
    const slot = inputsOf(schema!)[0]!
    if (slot.dynamic?.kind !== 'dynamicSlot') throw new Error('expected slot')
    expect(slot.dynamic.variants?.[0]!.inputs[0]!.dynamic).toMatchObject({
      kind: 'autogrow', naming: { kind: 'prefix', prefix: 'row', min: 1 },
    })
  })

  it('shares one nested-input parse budget across all dynamic constructs', () => {
    const dependents = Object.fromEntries(Array.from({ length: 514 }, (_, i) => [
      `nested${i}`, ['COMFY_DYNAMICCOMBO_V3', { options: [] }],
    ]))
    const { schema, diagnostics } = parseObjectInfoEntry('BudgetedSlot', {
      input: { required: { slot: ['COMFY_DYNAMICSLOT_V3', { slotType: 'IMAGE', inputs: { required: dependents } }] } }, output: [],
    } as ObjectInfoEntry)
    expect(diagnostics.filter((d) => d.code === 'schema.dynamic.budget')).toHaveLength(1)
    const slot = inputsOf(schema!)[0]!
    if (slot.dynamic?.kind !== 'dynamicSlot') throw new Error('expected slot')
    expect(slot.dynamic.inputs[511]!.dynamic?.kind).toBe('dynamicCombo')
    expect(slot.dynamic.inputs[512]!.dynamic).toBeUndefined()
    expect(slot.dynamic.inputs[513]!.dynamic).toBeUndefined()
  })

  it('round-trips parsed DynamicSlot selection and connectivity through elaboration', () => {
    const { schema, diagnostics } = parseObjectInfoEntry('RoundTripSlot', {
      input: { required: { slot: ['COMFY_DYNAMICSLOT_V3', { slotType: 'MODEL', variants: [{
        key: 'lora', type: 'LORA', inputs: { required: { weight: ['FLOAT', { default: 1 }] } },
      }] }] } }, output: [],
    })
    expect(diagnostics).toEqual([])
    const connectivity: Connectivity = {
      isInputConnected: (port) => port === 'slot',
      isOutputConnected: () => false,
    }
    const elaborated = elaborateInterface(schema!, { values: {}, dynamic: { slot: { selected: 'lora' } } }, connectivity)
    expect(elaborated.items.filter((item) => item.kind === 'input').map((item) => [item.address.port, item.apiName])).toEqual([
      ['slot', 'slot'], ['slot.[lora].weight', 'slot.weight'],
    ])
  })

  it('caps malicious wire nesting and leaves the deepest construct inert', () => {
    let wire: unknown = ['IMAGE', {}]
    for (let i = 0; i < 17; i++) {
      wire = ['COMFY_DYNAMICCOMBO_V3', { options: [{ key: 'next', inputs: { required: { [`level${i}`]: wire } } }] }]
    }
    const entry = { input: { required: { root: wire } }, output: [] } as ObjectInfoEntry
    const { schema, diagnostics } = parseObjectInfoEntry('TooDeep', entry)
    expect(diagnostics.map((d) => d.code)).toEqual(['schema.dynamic.depth'])
    let current = inputsOf(schema!)[0]!
    for (let i = 0; i < 16; i++) {
      expect(current.dynamic?.kind).toBe('dynamicCombo')
      if (current.dynamic?.kind !== 'dynamicCombo') break
      current = current.dynamic.options[0]!.inputs[0]!
    }
    expect(current.dynamic).toBeUndefined()
    expect(current.type).toEqual({ kind: 'wildcard' })
  })

  it('elaborates a nested construct discovered through object_info', () => {
    const { schema, diagnostics } = parseObjectInfoEntry('WireToElaboration', {
      input: { required: { rows: ['COMFY_AUTOGROW_V3', { template: {
        input: { required: { mode: ['COMFY_DYNAMICCOMBO_V3', { options: [
          { key: 'simple', inputs: { required: { amount: ['INT', { default: 3 }] } } },
        ] }] } }, prefix: 'row', min: 1, max: 2,
      } }] } }, output: [],
    })
    expect(diagnostics).toEqual([])
    const elaborated = elaborateInterface(schema!, { values: {} })
    expect(elaborated.diagnostics).toEqual([])
    expect(elaborated.items.some((item) => item.kind === 'input' && item.origin.kind === 'selector')).toBe(true)
    expect(elaborated.items.some((item) => item.kind === 'input' && item.origin.kind === 'branch')).toBe(true)
  })

  it('parses remote combo options', () => {
    const { schema } = parseObjectInfoEntry('RemoteCombo', {
      input: {
        required: {
          model_name: [
            'COMBO',
            { remote: { route: '/models/list', refresh_button: true, control_after_refresh: 'first', timeout: 5000 } },
          ],
        },
      },
      output: [],
      name: 'RemoteCombo',
    })
    const [combo] = inputsOf(schema!)
    expect(combo!.widget?.remote).toEqual({ route: '/models/list', refreshButton: true, controlAfterRefresh: 'first', timeoutMs: 5000 })
    expect(combo!.widget?.controller).toBe('after_refresh')
  })

  it('does not create an after-refresh controller from malformed or non-COMBO remote metadata', () => {
    const malformed = parseObjectInfoEntry('MalformedRemote', {
      input: { required: { model: ['COMBO', { remote: { route: '/models', control_after_refresh: 'middle' } }] } },
      output: [], name: 'MalformedRemote',
    }).schema!
    expect(inputsOf(malformed)[0]!.widget?.remote?.controlAfterRefresh).toBeUndefined()
    expect(inputsOf(malformed)[0]!.widget?.controller).toBeUndefined()

    const nonCombo = parseObjectInfoEntry('RemoteString', {
      input: { required: { text: ['STRING', { remote: { route: '/text', control_after_refresh: 'first' } }] } },
      output: [], name: 'RemoteString',
    }).schema!
    expect(inputsOf(nonCombo)[0]!.widget?.remote?.controlAfterRefresh).toBe('first')
    expect(inputsOf(nonCombo)[0]!.widget?.controller).toBeUndefined()
  })

  it('keeps unknown inputs missing from input_order', () => {
    const { schema, diagnostics } = parseObjectInfoEntry('Weird', {
      input: { required: { a: ['INT', {}], b: ['INT', {}] } },
      input_order: { required: ['a', 'missing'] },
      output: [],
      name: 'Weird',
    })
    expect(inputsOf(schema!).map((i) => i.id)).toEqual(['a', 'b'])
    expect(diagnostics.map((d) => d.code)).toContain('schema.inputOrder.dangling')
  })
})
