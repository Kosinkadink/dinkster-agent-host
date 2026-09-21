/**
 * Interface elaboration tests. The contract under test:
 * (schema, persisted state, link existence) -> effective ordered interface,
 * deterministic, with stable member identity, positional api names, branch-
 * local combo values, non-destructive slot hiding, and input/output symmetry.
 * Elaboration never sees solved types - nothing here constructs any.
 */
import { describe, expect, it } from 'vitest'
import type { GraphDef } from '../src/format/document.js'
import { asDynamicMemberId, asNodeId } from '../src/ids.js'
import {
  buildGraphConnectivity,
  defaultDynamicHandlers,
  elabInputsOf,
  elabKeyOf,
  elabOutputsOf,
  elaborateInterface,
  EMPTY_CONNECTIVITY,
  type Connectivity,
  type DynamicKindHandler,
  type ElaboratedInput,
} from '../src/schema/elaborate.js'
import { initialDynamicStateOf, type DynamicComboSpec, type InputSpec, type InterfaceItem, type NodeSchema, type OutputSpec } from '../src/schema/model.js'

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const schemaOf = (items: InterfaceItem[]): NodeSchema => ({
  type: 'Test',
  displayName: 'Test',
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  items,
})

const intInput = (id: string, extra: Partial<InputSpec> = {}): InputSpec => ({
  kind: 'input',
  id,
  type: { kind: 'concrete', name: 'INT' },
  optional: false,
  widget: { widgetType: 'INT', options: {}, default: 0 },
  ...extra,
})

const socketInput = (id: string, type = 'IMAGE', extra: Partial<InputSpec> = {}): InputSpec => ({
  kind: 'input',
  id,
  type: { kind: 'concrete', name: type },
  optional: false,
  ...extra,
})

const output = (id: string, type = 'IMAGE', extra: Partial<OutputSpec> = {}): OutputSpec => ({
  kind: 'output',
  id,
  type: { kind: 'concrete', name: type },
  ...extra,
})

const autogrowFamily = (id: string, opts: { min?: number; max?: number; names?: string[] } = {}): InputSpec => ({
  kind: 'input',
  id,
  type: { kind: 'wildcard' },
  optional: false,
  dynamic: {
    kind: 'autogrow',
    template: [socketInput('item', 'IMAGE')],
    naming: opts.names
      ? { kind: 'names', names: opts.names, ...(opts.min !== undefined ? { min: opts.min } : {}) }
      : { kind: 'prefix', prefix: 'image', min: opts.min ?? 1, max: opts.max ?? 4 },
  },
})

/** A grouped-template family: each member stamps an image + optional mask. */
const groupedFamily = (id: string, opts: { min?: number; max?: number } = {}): InputSpec => ({
  kind: 'input',
  id,
  type: { kind: 'wildcard' },
  optional: false,
  dynamic: {
    kind: 'autogrow',
    template: [socketInput('image', 'IMAGE'), socketInput('mask', 'MASK', { optional: true })],
    naming: { kind: 'prefix', prefix: 'item', min: opts.min ?? 1, max: opts.max ?? 3 },
  },
})

const comboConstruct = (id: string, options: { key: string; inputs: InputSpec[] }[]): InputSpec => ({
  kind: 'input',
  id,
  type: { kind: 'concrete', name: 'COMBO' },
  optional: false,
  dynamic: { kind: 'dynamicCombo', options },
})

const slotConstruct = (id: string, inputs: InputSpec[], slotType = 'MODEL'): InputSpec => ({
  kind: 'input',
  id,
  type: { kind: 'concrete', name: slotType },
  optional: true,
  dynamic: { kind: 'dynamicSlot', slotType: { kind: 'concrete', name: slotType }, inputs },
})

const samePath = (a?: readonly string[], b?: readonly string[]): boolean => {
  if (a === undefined || a.length === 0) return b === undefined || b.length === 0
  return b !== undefined && a.length === b.length && a.every((seg, i) => seg === b[i])
}

const connectedInputs = (...keys: [port: string, ...members: string[]][]): Connectivity => ({
  isInputConnected: (port, members) =>
    keys.some(([p, ...path]) => p === port && samePath(path, members)),
  isOutputConnected: () => false,
})

const noState = { values: {} }

// ---------------------------------------------------------------------------
// Static pass-through
// ---------------------------------------------------------------------------

describe('static schemas', () => {
  it('elaborates a static schema unchanged, in declared order', () => {
    const schema = schemaOf([
      output('out0'),
      socketInput('image'),
      { kind: 'section', id: 'adv', displayName: 'Advanced' },
      intInput('strength', { section: 'adv' }),
    ])
    const e = elaborateInterface(schema, noState)
    expect(e.diagnostics).toEqual([])
    expect(e.items.map((i) => (i.kind === 'section' ? `section:${i.spec.id}` : `${i.kind}:${elabKeyOf((i as ElaboratedInput).address)}`))).toEqual([
      'output:out0',
      'input:image',
      'section:adv',
      'input:strength',
    ])
    const strength = elabInputsOf(e).find((i) => i.address.port === 'strength')!
    expect(strength.origin).toEqual({ kind: 'static' })
    expect(strength.apiName).toBe('strength')
    expect(strength.spec).toBe(schema.items[3]) // no cloning on the static path
  })

  it('warns on schema ids containing reserved path characters', () => {
    const e = elaborateInterface(schemaOf([socketInput('a.b')]), noState)
    expect(e.diagnostics.some((d) => d.code === 'elab.id.reserved')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Autogrow
// ---------------------------------------------------------------------------

describe('autogrow', () => {
  it('orders wire-15 explicit members before value, structural, and dynamic evidence', () => {
    const family: InputSpec = {
      ...autogrowFamily('items', { min: 0, max: 8 }),
      dynamic: {
        kind: 'autogrow',
        materialization: 'wire15',
        template: [comboConstruct('mode', [{ key: 'on', inputs: [socketInput('value')] }])],
        naming: { kind: 'prefix', prefix: 'item', min: 0, max: 8 },
      },
    }
    const node = {
      values: { 'items.valued.mode.value': 1 },
      dynamic: {
        items: { members: ['explicit'] },
        'items.valued.mode': { selected: 'on' },
        'items.linked.mode': { selected: 'on' },
        'items.dynamic.mode': { selected: 'on' },
      },
    }
    const connectivity: Connectivity = {
      isInputConnected: (port) => port === 'items.linked.mode.value',
      isOutputConnected: () => false,
      inputPorts: () => ['items.linked.mode.value'],
    }
    const inputs = elabInputsOf(elaborateInterface(schemaOf([family]), node, connectivity))
    const memberOrder = inputs
      .filter((input) => input.origin.kind === 'selector' && input.apiName !== undefined)
      .map((input) => input.address.port.split('.')[1])
    expect(memberOrder).toEqual(['explicit', 'valued', 'linked', 'dynamic'])
    expect(inputs.find((input) => input.address.port === 'items.m0.mode')).toMatchObject({
      address: { port: 'items.m0.mode' },
      materialize: [{ construct: 'items', members: ['m0'] }],
    })
  })

  it('keeps structural wire-15 interface order independent of source mode', () => {
    const family: InputSpec = {
      ...autogrowFamily('items', { min: 0, max: 4 }),
      dynamic: {
        kind: 'autogrow', materialization: 'wire15',
        template: [socketInput('value')],
        naming: { kind: 'prefix', prefix: 'item', min: 0, max: 4 },
      },
    }
    const structuralConnectivity: Connectivity = {
      isInputConnected: (port) => port === 'items.linked',
      isOutputConnected: () => false,
      inputPorts: () => ['items.linked'],
    }
    const state = { values: {} }
    const activeOccurrence = elaborateInterface(schemaOf([family]), state, structuralConnectivity)
    const mutedSourceOccurrence = elaborateInterface(schemaOf([family]), state, structuralConnectivity)
    expect(elabInputsOf(activeOccurrence).map((input) => input.address.port)).toEqual(['items.linked', 'items.m0'])
    expect(elabInputsOf(activeOccurrence)[1]).toMatchObject({
      origin: { kind: 'member', construct: 'items', ordinal: 1, ghost: true },
      materialize: [{ construct: 'items', members: ['m0'] }],
    })
    expect(elabInputsOf(activeOccurrence)[1]!.apiName).toBeUndefined()
    expect(mutedSourceOccurrence).toEqual(activeOccurrence)
  })

  it('fresh node: synthesizes members up to min plus one trailing ghost', () => {
    const e = elaborateInterface(schemaOf([autogrowFamily('images', { min: 2, max: 4 })]), noState)
    const inputs = elabInputsOf(e)
    expect(inputs).toHaveLength(3)
    // Member addresses use the stamped slot path ('<family>.<slotId>') even
    // for single-slot templates, so growing a template into a group later
    // never reshapes existing addresses.
    expect(inputs.map((i) => i.address)).toEqual([
      { port: 'images.item', members: ['m0'] },
      { port: 'images.item', members: ['m1'] },
      { port: 'images.item', members: ['m2'] },
    ])
    expect(inputs.map((i) => i.origin)).toEqual([
      { kind: 'member', construct: 'images', ordinal: 0 },
      { kind: 'member', construct: 'images', ordinal: 1 },
      { kind: 'member', construct: 'images', ordinal: 2, ghost: true },
    ])
    // First min are required; ghost is optional and never compiles.
    expect(inputs.map((i) => i.spec.optional)).toEqual([false, false, true])
    expect(inputs.map((i) => i.apiName)).toEqual(['images.image0', 'images.image1', undefined])
  })

  it('persisted members keep their ids; api names are positional', () => {
    const node = { values: {}, dynamic: { images: { members: ['m5', 'm2'] } } }
    const e = elaborateInterface(schemaOf([autogrowFamily('images', { min: 1, max: 4 })]), node)
    const inputs = elabInputsOf(e)
    expect(inputs.map((i) => [i.address.members, i.apiName])).toEqual([
      [['m5'], 'images.image0'], // ordinal 0 regardless of id
      [['m2'], 'images.image1'],
      [['m6'], undefined], // ghost continues past the highest used suffix
    ])
  })

  it('never recycles removed member ids when seq is maintained', () => {
    // m3 was created and removed; members shrank back but seq records 4.
    const node = { values: {}, dynamic: { images: { members: ['m0'], seq: 4 } } }
    const e = elaborateInterface(schemaOf([autogrowFamily('images')]), node)
    const ghost = elabInputsOf(e).at(-1)!
    expect(ghost.origin).toMatchObject({ ghost: true })
    expect(ghost.address.members).toEqual(['m4'])
  })

  it('stops growing at the cap and warns above it', () => {
    const capped = elaborateInterface(
      schemaOf([autogrowFamily('images', { min: 1, max: 2 })]),
      { values: {}, dynamic: { images: { members: ['m0', 'm1'] } } },
    )
    expect(elabInputsOf(capped)).toHaveLength(2) // no ghost at cap
    expect(capped.diagnostics).toEqual([])

    const over = elaborateInterface(
      schemaOf([autogrowFamily('images', { min: 1, max: 2 })]),
      { values: {}, dynamic: { images: { members: ['m0', 'm1', 'm2'] } } },
    )
    expect(over.diagnostics.some((d) => d.code === 'elab.autogrow.overMax')).toBe(true)
    const extras = elabInputsOf(over)
    expect(extras).toHaveLength(3) // loadable + fixable: extras render...
    expect(extras[2]!.apiName).toBeUndefined() // ...but never compile
  })

  it('names-list naming uses the declared names as api names and labels', () => {
    const e = elaborateInterface(
      schemaOf([autogrowFamily('ops', { names: ['first', 'second'], min: 1 })]),
      { values: {}, dynamic: { ops: { members: ['m0'] } } },
    )
    const inputs = elabInputsOf(e)
    expect(inputs.map((i) => [i.spec.displayName, i.apiName])).toEqual([
      ['first', 'ops.first'],
      ['second', undefined], // ghost
    ])
  })

  it('a connected trailing member is real, not a ghost', () => {
    const node = { values: {}, dynamic: { images: { members: ['m0'] } } }
    const facts = connectedInputs(['images.item', 'm1'])
    const e = elaborateInterface(schemaOf([autogrowFamily('images', { min: 1, max: 4 })]), node, facts)
    const last = elabInputsOf(e).at(-1)!
    expect(last.address.members).toEqual(['m1'])
    expect(last.origin).toEqual({ kind: 'member', construct: 'images', ordinal: 1 })
    expect(last.apiName).toBe('images.image1')
  })

  it('members inherit the family section for presentation', () => {
    const e = elaborateInterface(
      schemaOf([{ kind: 'section', id: 's' }, autogrowFamily('images', { min: 1 }) ]
        .map((it, i) => (i === 1 ? { ...it, section: 's' } : it)) as InterfaceItem[],
      ),
      noState,
    )
    for (const input of elabInputsOf(e)) expect(input.spec.section).toBe('s')
  })
})

// ---------------------------------------------------------------------------
// Autogrow ordinal offset (derived boundary families: the definition prefix
// owns ordinals 0..offset-1, instance members continue after it)
// ---------------------------------------------------------------------------

describe('autogrow ordinal offset', () => {
  const offsetPrefixFamily = (ordinalOffset: number): InputSpec => ({
    kind: 'input',
    id: 'images',
    type: { kind: 'wildcard' },
    optional: false,
    dynamic: {
      kind: 'autogrow',
      template: [socketInput('item', 'IMAGE')],
      naming: { kind: 'prefix', prefix: 'image', min: 1, max: 2 },
      ordinalOffset,
    },
  })

  it('prefix naming continues after the definition prefix; bounds stay local', () => {
    const e = elaborateInterface(schemaOf([offsetPrefixFamily(2)]), noState)
    expect(e.diagnostics).toEqual([])
    const inputs = elabInputsOf(e)
    // Local min 1 -> one real member + one ghost, exactly as without offset.
    expect(inputs).toHaveLength(2)
    // Wire names and reported ordinals continue the definition's numbering
    // (the definition owns image0/image1); member ids stay local identity.
    expect(inputs.map((i) => i.apiName)).toEqual(['images.image2', undefined])
    expect(inputs.map((i) => i.origin)).toEqual([
      { kind: 'member', construct: 'images', ordinal: 2 },
      { kind: 'member', construct: 'images', ordinal: 3, ghost: true },
    ])
    expect(inputs.map((i) => i.address.members)).toEqual([['m0'], ['m1']])
  })

  it('names-list naming is already sliced by derive: offset shifts ordinals only', () => {
    const e = elaborateInterface(
      schemaOf([
        {
          kind: 'input',
          id: 'ins',
          type: { kind: 'wildcard' },
          optional: false,
          dynamic: {
            kind: 'autogrow',
            template: [socketInput('in', 'IMAGE')],
            naming: { kind: 'names', names: ['b', 'c'], min: 1 },
            ordinalOffset: 1,
          },
        },
      ]),
      noState,
    )
    expect(e.diagnostics).toEqual([])
    const inputs = elabInputsOf(e)
    expect(inputs.map((i) => i.apiName)).toEqual(['ins.b', undefined])
    expect(inputs.map((i) => i.origin)).toEqual([
      { kind: 'member', construct: 'ins', ordinal: 1 },
      { kind: 'member', construct: 'ins', ordinal: 2, ghost: true },
    ])
  })
})

// ---------------------------------------------------------------------------
// Autogrow grouped templates (one member = one stamped group)
// ---------------------------------------------------------------------------

describe('autogrow grouped templates', () => {
  it('stamps every template slot per member, in declared order, sharing member id and ordinal', () => {
    const e = elaborateInterface(schemaOf([groupedFamily('items', { min: 1, max: 3 })]), noState)
    expect(e.diagnostics).toEqual([])
    const inputs = elabInputsOf(e)
    // min 1 -> one real member (both slots), plus one ghost group.
    expect(inputs.map((i) => i.address)).toEqual([
      { port: 'items.image', members: ['m0'] },
      { port: 'items.mask', members: ['m0'] },
      { port: 'items.image', members: ['m1'] },
      { port: 'items.mask', members: ['m1'] },
    ])
    expect(inputs.map((i) => i.origin)).toEqual([
      { kind: 'member', construct: 'items', ordinal: 0 },
      { kind: 'member', construct: 'items', ordinal: 0 },
      { kind: 'member', construct: 'items', ordinal: 1, ghost: true },
      { kind: 'member', construct: 'items', ordinal: 1, ghost: true },
    ])
    // Per-slot optionality survives inside a required member; ghosts are
    // always optional.
    expect(inputs.map((i) => i.spec.optional)).toEqual([false, true, true, true])
    expect(inputs.map((i) => i.spec.displayName)).toEqual([
      'item0.image',
      'item0.mask',
      'item1.image',
      'item1.mask',
    ])
    // Provisional nested wire names for grouped templates; ghosts never compile.
    expect(inputs.map((i) => i.apiName)).toEqual([
      'items.item0.image',
      'items.item0.mask',
      undefined,
      undefined,
    ])
  })

  it('a connection on ANY slot of the ghost group promotes the whole group', () => {
    const node = { values: {}, dynamic: { items: { members: ['m0'] } } }
    // Connect only the OPTIONAL mask slot of the ghost member.
    const facts = connectedInputs(['items.mask', 'm1'])
    const e = elaborateInterface(schemaOf([groupedFamily('items', { min: 1, max: 3 })]), node, facts)
    const promoted = elabInputsOf(e).filter((i) => samePath(i.address.members, ['m1']))
    expect(promoted).toHaveLength(2)
    for (const input of promoted) {
      expect(input.origin).toEqual({ kind: 'member', construct: 'items', ordinal: 1 })
    }
    expect(promoted.map((i) => i.apiName)).toEqual(['items.item1.image', 'items.item1.mask'])
  })

  it('keeps nested structural paths while removing a duplicated family segment from labels', () => {
    const nested: InputSpec = {
      ...autogrowFamily('groups', { names: ['images'], min: 1 }),
      dynamic: {
        kind: 'autogrow',
        template: [{
          ...autogrowFamily('nested', { min: 1, max: 2 }),
          dynamic: {
            kind: 'autogrow',
            template: [socketInput('image')],
            naming: { kind: 'prefix', prefix: 'images_m', min: 1, max: 2 },
          },
        }],
        naming: { kind: 'names', names: ['images'], min: 1 },
      },
    }
    const state = {
      values: {},
      dynamic: {
        groups: {
          members: ['outer'],
          memberState: { outer: { 'groups.nested': { members: ['inner'] } } },
        },
      },
    }

    const inputs = elabInputsOf(elaborateInterface(schemaOf([nested]), state))
    const persisted = inputs.find((candidate) => candidate.address.members?.[1] === 'inner')!
    expect(persisted.address).toEqual({ port: 'groups.nested.image', members: ['outer', 'inner'] })
    expect(persisted.apiName).toBe('groups.images.nested.images_m0')
    expect(persisted.spec.displayName).toBe('images_m0')
    expect(new Set(inputs.map((candidate) => candidate.spec.id)).size).toBe(inputs.length)
  })

  it('retains ancestor label context when suppressing a repeated nested family stem', () => {
    const nested: InputSpec = {
      kind: 'input',
      id: 'outer',
      type: { kind: 'wildcard' },
      optional: false,
      dynamic: {
        kind: 'autogrow',
        template: [{
          kind: 'input',
          id: 'middle',
          type: { kind: 'wildcard' },
          optional: false,
          dynamic: {
            kind: 'autogrow',
            template: [{
              kind: 'input',
              id: 'nested',
              type: { kind: 'wildcard' },
              optional: false,
              dynamic: {
                kind: 'autogrow',
                template: [socketInput('image')],
                naming: { kind: 'prefix', prefix: 'images_m', min: 0, max: 2 },
              },
            }],
            naming: { kind: 'names', names: ['images'], min: 0 },
          },
        }],
        naming: { kind: 'prefix', prefix: 'item', min: 0, max: 2 },
      },
    }
    const state = {
      values: {},
      dynamic: {
        outer: {
          members: ['o0', 'o1'],
          memberState: {
            o0: {
              'outer.middle': {
                members: ['m0'],
                memberState: { m0: { 'outer.middle.nested': { members: ['i0'] } } },
              },
            },
            o1: {
              'outer.middle': {
                members: ['m1'],
                memberState: { m1: { 'outer.middle.nested': { members: ['i1'] } } },
              },
            },
          },
        },
      },
    }

    const labels = elabInputsOf(elaborateInterface(schemaOf([nested]), state))
      .filter((candidate) =>
        candidate.origin.kind === 'member'
        && !candidate.origin.ghost
        && candidate.address.port.endsWith('.image'))
      .map((candidate) => candidate.spec.displayName)
    expect(labels).toEqual(['item0.images_m0', 'item1.images_m0'])
  })

  it('grouped member ids stay stable across shrink and regrowth', () => {
    // m1 was created and removed; seq records 2, so the ghost group is m2.
    const node = { values: {}, dynamic: { items: { members: ['m0'], seq: 2 } } }
    const e = elaborateInterface(schemaOf([groupedFamily('items', { min: 1, max: 3 })]), node)
    const ghosts = elabInputsOf(e).filter((i) => (i.origin as { ghost?: boolean }).ghost)
    expect(ghosts.map((i) => i.address)).toEqual([
      { port: 'items.image', members: ['m2'] },
      { port: 'items.mask', members: ['m2'] },
    ])
  })

  it('an empty template is diagnosed and not elaborated', () => {
    const empty: InputSpec = {
      kind: 'input',
      id: 'items',
      type: { kind: 'wildcard' },
      optional: false,
      dynamic: { kind: 'autogrow', template: [], naming: { kind: 'prefix', prefix: 'item' } },
    }
    const e = elaborateInterface(schemaOf([empty]), noState)
    expect(e.diagnostics.some((d) => d.code === 'elab.autogrow.emptyTemplate')).toBe(true)
    expect(elabInputsOf(e)).toHaveLength(0)
  })

  describe('growth affordance (nested-only templates, hazard N3)', () => {
    const growthsOf = (e: ReturnType<typeof elaborateInterface>) =>
      e.items.filter((i): i is Extract<typeof i, { kind: 'growth' }> => i.kind === 'growth')
    const nested = (opts: { innerMin: number; outerMin?: number; withStatic?: boolean }): InputSpec => ({
      kind: 'input',
      id: 'items',
      type: { kind: 'wildcard' },
      optional: false,
      dynamic: {
        kind: 'autogrow',
        template: [
          ...(opts.withStatic ? [socketInput('img')] : []),
          {
            ...socketInput('sub'),
            optional: true,
            dynamic: {
              kind: 'autogrow',
              template: [socketInput('s')],
              naming: { kind: 'prefix', prefix: 'sub', min: opts.innerMin, max: 4 },
            },
          },
        ],
        naming: { kind: 'prefix', prefix: 'item', min: opts.outerMin ?? 0, max: 5 },
      },
    })

    it('a ghost that emits nothing is replaced by a growth item with materialize frames', () => {
      // Fresh node, min-0 outer, min-0 inner: the trailing ghost's inner
      // ghost tree is suppressed (single-ghost rule), so a growth affordance
      // stands in. Its frames persist the offered member.
      const bare = elaborateInterface(schemaOf([nested({ innerMin: 0 })]), noState)
      expect(elabInputsOf(bare)).toHaveLength(0)
      expect(growthsOf(bare)).toEqual([
        {
          kind: 'growth',
          construct: 'items',
          side: 'input',
          label: 'items',
          frames: [{ construct: 'items', members: ['m0'] }],
        },
      ])
    })

    it('no growth item when the ghost renders something', () => {
      // Inner min > 0: the ghost member min-fills its inner family -
      // grabbable pins exist, so connect-to-materialize covers growth.
      const minFill = elaborateInterface(schemaOf([nested({ innerMin: 1 })]), noState)
      expect(growthsOf(minFill)).toHaveLength(0)
      expect(elabInputsOf(minFill).length).toBeGreaterThan(0)

      // A static slot alongside the construct renders the ghost: no growth.
      const mixed = elaborateInterface(schemaOf([nested({ innerMin: 0, withStatic: true })]), noState)
      expect(growthsOf(mixed)).toHaveLength(0)
    })

    it('min-fill members ride the growth frames (they must persist with the ghost)', () => {
      // Outer min 1: synthetic m0 renders its inner family's ghost, but the
      // outer TRAILING ghost m1 still renders nothing - the growth item for
      // m1 carries m0 too, or m0's id would silently re-mint on regrowth.
      const grown = elaborateInterface(schemaOf([nested({ innerMin: 0, outerMin: 1 })]), noState)
      expect(growthsOf(grown)).toEqual([
        {
          kind: 'growth',
          construct: 'items',
          side: 'input',
          label: 'items',
          frames: [{ construct: 'items', members: ['m0', 'm1'] }],
        },
      ])
    })

    it('persisted members shift the offer; capacity removes it', () => {
      const node = (members: string[], seq: number) => ({
        values: {},
        dynamic: { items: { members, seq } },
      })
      const one = elaborateInterface(schemaOf([nested({ innerMin: 0 })]), node(['m0'], 1))
      expect(growthsOf(one)[0]!.frames).toEqual([{ construct: 'items', members: ['m1'] }])
      // At the family cap (max 5) there is no ghost and no growth offer.
      const full = elaborateInterface(
        schemaOf([nested({ innerMin: 0 })]),
        node(['m0', 'm1', 'm2', 'm3', 'm4'], 5),
      )
      expect(growthsOf(full)).toHaveLength(0)
    })

    it('nested growth: an inner nested-only family offers two-level frames', () => {
      // items > sub > leaf, every level min-0 nested-only until the leaf.
      const doubly: InputSpec = {
        kind: 'input',
        id: 'items',
        type: { kind: 'wildcard' },
        optional: false,
        dynamic: {
          kind: 'autogrow',
          template: [
            {
              ...socketInput('sub'),
              optional: true,
              dynamic: {
                kind: 'autogrow',
                template: [
                  {
                    ...socketInput('leaf'),
                    optional: true,
                    dynamic: {
                      kind: 'autogrow',
                      template: [socketInput('s')],
                      naming: { kind: 'prefix', prefix: 'leaf', min: 0, max: 3 },
                    },
                  },
                ],
                naming: { kind: 'prefix', prefix: 'sub', min: 0, max: 3 },
              },
            },
          ],
          naming: { kind: 'prefix', prefix: 'item', min: 0, max: 3 },
        },
      }
      // Fresh: only the OUTER growth offers (progressive disclosure - the
      // inner families do not exist until a member does).
      const fresh = elaborateInterface(schemaOf([doubly]), noState)
      expect(growthsOf(fresh).map((g) => g.construct)).toEqual(['items'])
      // With outer m0 persisted, the inner family under it offers growth
      // through BOTH levels: the persisted ancestor frame plus its own.
      const grown = elaborateInterface(schemaOf([doubly]), {
        values: {},
        dynamic: { items: { members: ['m0'], seq: 1 } },
      })
      const inner = growthsOf(grown).find((g) => g.construct === 'items.sub')
      expect(inner).toEqual({
        kind: 'growth',
        construct: 'items.sub',
        side: 'input',
        label: 'item0.sub',
        frames: [
          { construct: 'items', members: ['m0'] },
          { construct: 'items.sub', members: ['m0'] },
        ],
      })
      // The outer family's own next-member offer is unaffected.
      expect(growthsOf(grown).some((g) => g.construct === 'items')).toBe(true)
    })

    it('output-side nested-only families offer growth symmetrically', () => {
      const out: OutputSpec = {
        kind: 'output',
        id: 'outs',
        type: { kind: 'wildcard' },
        dynamic: {
          kind: 'autogrow',
          template: [
            {
              ...socketInput('sub'),
              optional: true,
              dynamic: {
                kind: 'autogrow',
                template: [socketInput('s')],
                naming: { kind: 'prefix', prefix: 'sub', min: 0, max: 3 },
              },
            },
          ],
          naming: { kind: 'prefix', prefix: 'out', min: 0, max: 3 },
        },
      }
      const e = elaborateInterface(schemaOf([out]), noState)
      expect(growthsOf(e)).toEqual([
        {
          kind: 'growth',
          construct: 'outs',
          side: 'output',
          label: 'outs',
          frames: [{ construct: 'outs', members: ['m0'] }],
        },
      ])
    })

    it('no growth item beneath a ghost ancestor (single-ghost rule holds)', () => {
      // The outer ghost's inner nested-only family must NOT offer growth:
      // nothing beneath a ghost is persistable, and the outer growth/ghost
      // is the single affordance for that subtree.
      const bare = elaborateInterface(schemaOf([nested({ innerMin: 0 })]), noState)
      expect(growthsOf(bare).every((g) => g.construct === 'items')).toBe(true)
    })
  })

  it('warns on template slot ids containing reserved path characters', () => {
    const bad: InputSpec = {
      kind: 'input',
      id: 'items',
      type: { kind: 'wildcard' },
      optional: false,
      dynamic: {
        kind: 'autogrow',
        template: [socketInput('a.b')],
        naming: { kind: 'prefix', prefix: 'item', min: 1, max: 2 },
      },
    }
    const e = elaborateInterface(schemaOf([bad]), noState)
    expect(e.diagnostics.some((d) => d.code === 'elab.id.reserved')).toBe(true)
  })

  it('grouped output families elaborate symmetrically', () => {
    const family: OutputSpec = {
      kind: 'output',
      id: 'results',
      type: { kind: 'wildcard' },
      dynamic: {
        kind: 'autogrow',
        template: [socketInput('image', 'IMAGE'), socketInput('mask', 'MASK')],
        naming: { kind: 'prefix', prefix: 'result', min: 1, max: 2 },
      },
    }
    const e = elaborateInterface(schemaOf([family]), { values: {}, dynamic: { results: { members: ['m0'] } } })
    const outs = elabOutputsOf(e)
    expect(outs.map((o) => [elabKeyOf(o.address), o.spec.displayName])).toEqual([
      ['results.image#m0', 'result0.image'],
      ['results.mask#m0', 'result0.mask'],
      ['results.image#m1', 'result1.image'], // ghost group affordance
      ['results.mask#m1', 'result1.mask'],
    ])
    expect(outs[1]!.spec.type).toEqual({ kind: 'concrete', name: 'MASK' })
  })
})

// ---------------------------------------------------------------------------
// DynamicCombo
// ---------------------------------------------------------------------------

describe('dynamicCombo', () => {
  const modes = comboConstruct('mode', [
    { key: 'simple', inputs: [intInput('strength')] },
    { key: 'advanced', inputs: [intInput('strength'), socketInput('mask', 'MASK')] },
  ])

  it('emits a COMBO selector whose value is dynamic state, then the active branch', () => {
    const e = elaborateInterface(schemaOf([modes]), noState)
    const inputs = elabInputsOf(e)
    const selector = inputs[0]!
    expect(selector.origin).toEqual({ kind: 'selector', construct: 'mode' })
    expect(selector.spec.widget).toMatchObject({ widgetType: 'COMBO', options: { options: ['simple', 'advanced'] } })
    expect(selector.derivedValue).toBe('simple') // defaults to first option
    expect(selector.apiName).toBe('mode')
    // Active branch inputs: branch-local value keys, option-stripped api names.
    expect(inputs.slice(1).map((i) => [i.address.port, i.apiName])).toEqual([['mode.[simple].strength', 'mode.strength']])
  })

  it('switching options swaps branches; value keys never collide across branches', () => {
    const simple = elaborateInterface(schemaOf([modes]), { values: {}, dynamic: { mode: { selected: 'simple' } } })
    const advanced = elaborateInterface(schemaOf([modes]), { values: {}, dynamic: { mode: { selected: 'advanced' } } })
    const keysOf = (e: ReturnType<typeof elaborateInterface>) => elabInputsOf(e).slice(1).map((i) => i.address.port)
    expect(keysOf(simple)).toEqual(['mode.[simple].strength'])
    expect(keysOf(advanced)).toEqual(['mode.[advanced].strength', 'mode.[advanced].mask'])
    // Same input id, different branches -> different document keys: switching
    // back restores the branch's stored values because nothing ever collided.
    expect(keysOf(simple)[0]).not.toBe(keysOf(advanced)[0])
    for (const i of elabInputsOf(advanced).slice(1)) {
      expect(i.origin).toEqual({ kind: 'branch', construct: 'mode', option: 'advanced' })
    }
  })

  it('re-keyed branch inputs keep the short id as displayName', () => {
    // spec.id becomes the full elaborated address ('mode.[simple].strength');
    // without an authored displayName the human label must stay the leaf
    // name, never the address.
    const e = elaborateInterface(schemaOf([modes]), noState)
    for (const i of elabInputsOf(e).slice(1)) {
      expect(i.spec.displayName).toBe('strength')
    }
  })

  it('unknown selected option falls back to the first with a warning', () => {
    const e = elaborateInterface(schemaOf([modes]), { values: {}, dynamic: { mode: { selected: 'gone' } } })
    expect(e.diagnostics.some((d) => d.code === 'elab.combo.unknownOption')).toBe(true)
    expect(elabInputsOf(e)[0]!.derivedValue).toBe('simple')
  })

  it('empty options produce a warning and a bare selector', () => {
    const e = elaborateInterface(schemaOf([comboConstruct('mode', [])]), noState)
    expect(e.diagnostics.some((d) => d.code === 'elab.combo.empty')).toBe(true)
    expect(elabInputsOf(e)).toHaveLength(1)
  })

  it('uses the first wire-15 option for absent state and ignores descriptor defaults', () => {
    const first = intInput('width')
    const second = intInput('multiplier')
    const combo: InputSpec = {
      ...comboConstruct('resize_type', [
        { key: 'scale dimensions', inputs: [first] },
        { key: 'scale by multiplier', inputs: [second] },
      ]),
      dynamic: {
        kind: 'dynamicCombo',
        materialization: 'wire15',
        defaultOption: 'scale by multiplier',
        options: [
          { key: 'scale dimensions', inputs: [first] },
          { key: 'scale by multiplier', inputs: [second] },
        ],
      },
    }
    const node = { values: {}, dynamic: {} }
    const e = elaborateInterface(schemaOf([combo]), node)
    expect(e.diagnostics).toEqual([])
    expect(elabInputsOf(e).map((input) => input.address.port)).toEqual([
      'resize_type',
      'resize_type.width',
    ])
    expect(elabInputsOf(e)[0]).toMatchObject({
      origin: { kind: 'selector', construct: 'resize_type' },
      derivedValue: 'scale dimensions',
      spec: {
        widget: {
          widgetType: 'COMBO',
          options: { options: ['scale dimensions', 'scale by multiplier'] },
          default: 'scale dimensions',
        },
      },
    })
    expect(e.submissionValues).toEqual([])
    expect(node.dynamic).toEqual({})

    const explicit = elaborateInterface(schemaOf([combo]), {
      values: {},
      dynamic: { resize_type: { selected: 'scale by multiplier' } },
    })
    expect(explicit.diagnostics).toEqual([])
    expect(elabInputsOf(explicit).map((input) => input.address.port)).toEqual([
      'resize_type',
      'resize_type.multiplier',
    ])
    expect(elabInputsOf(explicit)[0]?.derivedValue).toBe('scale by multiplier')
  })

  it('uses the first wire-15 option without a default and keeps invalid stored state loud', () => {
    const combo: InputSpec = {
      ...comboConstruct('mode', [
        { key: 'first', inputs: [intInput('value')] },
        { key: 'second', inputs: [] },
      ]),
      dynamic: {
        kind: 'dynamicCombo',
        materialization: 'wire15',
        options: [
          { key: 'first', inputs: [intInput('value')] },
          { key: 'second', inputs: [] },
        ],
      },
    }
    const fresh = elaborateInterface(schemaOf([combo]), noState)
    expect(elabInputsOf(fresh).map((input) => input.address.port)).toEqual(['mode', 'mode.value'])
    expect(fresh.submissionValues).toEqual([])

    const invalid = elaborateInterface(schemaOf([combo]), {
      values: {},
      dynamic: { mode: { selected: 'gone' } },
    })
    expect(invalid.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['prompt.bad_dynamic_choice'])
    expect(elabInputsOf(invalid)).toEqual([])
    expect(invalid.submissionValues).toEqual([])
  })

  it('initializes nested first branches but not inactive or empty wire-15 choices', () => {
    const nested = (id: string, options: DynamicComboSpec): InputSpec => ({
      kind: 'input',
      id,
      type: { kind: 'wildcard' },
      optional: false,
      dynamic: options,
    })
    const inner = nested('inner', {
      kind: 'dynamicCombo',
      materialization: 'wire15',
      options: [{ key: 'inner first', inputs: [] }, { key: 'inner second', inputs: [] }],
    })
    const inactive = nested('inactive', {
      kind: 'dynamicCombo',
      materialization: 'wire15',
      options: [{ key: 'inactive first', inputs: [] }],
    })
    const outer = nested('outer', {
      kind: 'dynamicCombo',
      materialization: 'wire15',
      options: [{ key: 'outer first', inputs: [inner] }, { key: 'outer second', inputs: [inactive] }],
    })
    const empty = nested('empty', {
      kind: 'dynamicCombo',
      materialization: 'wire15',
      options: [],
    })
    expect(initialDynamicStateOf(schemaOf([outer, empty]))).toEqual({
      outer: { selected: 'outer first' },
      'outer.inner': { selected: 'inner first' },
    })
  })
})

// ---------------------------------------------------------------------------
// DynamicSlot
// ---------------------------------------------------------------------------

describe('dynamicSlot', () => {
  const slot = slotConstruct('model', [intInput('lora_strength'), socketInput('clip', 'CLIP')])
  const specialized = (variantInputs: InputSpec[] = [intInput('weight')]): InputSpec => ({
    ...slotConstruct('model', [intInput('shared')]),
    dynamic: {
      kind: 'dynamicSlot', slotType: { kind: 'concrete', name: 'MODEL' }, inputs: [intInput('shared')],
      variants: [{ key: 'lora', type: { kind: 'concrete', name: 'LORA' }, inputs: variantInputs }],
    },
  })

  it('disconnected: only the slot itself, typed and optional', () => {
    const e = elaborateInterface(schemaOf([slot]), noState)
    const inputs = elabInputsOf(e)
    expect(inputs).toHaveLength(1)
    expect(inputs[0]!.origin).toEqual({ kind: 'slot', construct: 'model' })
    expect(inputs[0]!.spec.type).toEqual({ kind: 'concrete', name: 'MODEL' })
    expect(inputs[0]!.spec.optional).toBe(true)
    expect(inputs[0]!.apiName).toBe('model')
    expect(inputs[0]!.origin).not.toHaveProperty('variants')
  })

  it('connected: dependents appear with slot-scoped keys; disconnect hides, never deletes', () => {
    const e = elaborateInterface(schemaOf([slot]), noState, connectedInputs(['model']))
    const inputs = elabInputsOf(e)
    expect(inputs.map((i) => [i.address.port, i.apiName])).toEqual([
      ['model', 'model'],
      ['model.lora_strength', 'model.lora_strength'],
      ['model.clip', 'model.clip'],
    ])
    expect(inputs[1]!.origin).toEqual({ kind: 'dependent', construct: 'model' })
    // Hiding is pure derivation: the same node state with no connection just
    // elaborates fewer ports - values in the document are untouched.
    const hidden = elaborateInterface(schemaOf([slot]), noState)
    expect(elabInputsOf(hidden)).toHaveLength(1)
  })

  it('selected variant elaborates bracket-keyed inputs with construct-local wire names', () => {
    // Settled contract (c2ac572): the choice travels once per node as
    // slotVariants; dependents lower construct-local ('model.weight'),
    // while document keys stay variant-bracketed so switching variants
    // never reinterprets stored values.
    const e = elaborateInterface(schemaOf([specialized()]), { values: {}, dynamic: { model: { selected: 'lora' } } }, connectedInputs(['model']))
    expect(elabInputsOf(e).map((i) => [i.address.port, i.apiName])).toEqual([
      ['model', 'model'], ['model.shared', 'model.shared'], ['model.[lora].weight', 'model.weight'],
    ])
  })

  it('surfaces the per-variant widget spec', () => {
    const e = elaborateInterface(schemaOf([specialized([intInput('weight', { widget: { widgetType: 'FLOAT', options: { min: 0 }, default: 0.5 } })])]), { values: {}, dynamic: { model: { selected: 'lora' } } }, connectedInputs(['model']))
    expect(elabInputsOf(e)[2]!.spec.widget).toEqual({ widgetType: 'FLOAT', options: { min: 0 }, default: 0.5 })
  })

  it('skips a variant input reusing a shared dependent id, loudly', () => {
    // Under construct-local wire naming both would lower to 'model.shared';
    // the shared dependent wins and the collision is diagnosed, never
    // silently clobbered. (The native wire cannot produce this - it has no
    // slot-level shared dependents - so this guards the compat model only.)
    const e = elaborateInterface(schemaOf([specialized([intInput('shared')])]), { values: {}, dynamic: { model: { selected: 'lora' } } }, connectedInputs(['model']))
    expect(e.diagnostics.map((d) => d.code)).toContain('elab.slot.shadowedDependent')
    expect(elabInputsOf(e).map((i) => [i.address.port, i.apiName])).toEqual([
      ['model', 'model'], ['model.shared', 'model.shared'],
    ])
  })

  it('warns and uses only the base form for an unknown selected variant', () => {
    const e = elaborateInterface(schemaOf([specialized()]), { values: {}, dynamic: { model: { selected: 'gone' } } }, connectedInputs(['model']))
    expect(e.diagnostics.map((d) => d.code)).toContain('elab.slot.unknownVariant')
    expect(elabInputsOf(e).map((i) => i.address.port)).toEqual(['model', 'model.shared'])
  })

  it('keeps selected variant inputs hidden while disconnected and restores them purely', () => {
    const state = { values: { 'model.[lora].weight': 2 }, dynamic: { model: { selected: 'lora' } } }
    expect(elabInputsOf(elaborateInterface(schemaOf([specialized()]), state)).map((i) => i.address.port)).toEqual(['model'])
    expect(elabInputsOf(elaborateInterface(schemaOf([specialized()]), state, connectedInputs(['model']))).map((i) => i.address.port)).toEqual(['model', 'model.shared', 'model.[lora].weight'])
  })

  it('reads specialization from autogrow member state', () => {
    const family = autogrowFamily('items', { min: 0, max: 2 })
    if (family.dynamic?.kind !== 'autogrow') throw new Error('expected autogrow')
    const nested = { ...family, dynamic: { ...family.dynamic, template: [specialized()] } }
    const state = { values: {}, dynamic: { items: { members: ['m0'], memberState: { m0: { 'items.model': { selected: 'lora' } } } } } }
    const e = elaborateInterface(schemaOf([nested]), state, connectedInputs(['items.model', 'm0']))
    expect(elabInputsOf(e).map((i) => elabKeyOf(i.address))).toEqual(['items.model#m0', 'items.model.shared#m0', 'items.model.[lora].weight#m0', 'items.model#m1'])
  })

  it('carries variants and selected key in slot origin metadata', () => {
    const e = elaborateInterface(schemaOf([specialized()]), { values: {}, dynamic: { model: { selected: 'lora' } } })
    expect(elabInputsOf(e)[0]!.origin).toEqual({ kind: 'slot', construct: 'model', variants: [{ key: 'lora', type: { kind: 'concrete', name: 'LORA' } }], selected: 'lora' })
  })
})

// ---------------------------------------------------------------------------
// Nesting
// ---------------------------------------------------------------------------

describe('nested constructs', () => {
  it('an autogrow inside a combo branch keys state and members by construct path', () => {
    const schema = schemaOf([
      comboConstruct('mode', [
        { key: 'multi', inputs: [autogrowFamily('images', { min: 1, max: 3 })] },
        { key: 'single', inputs: [socketInput('image')] },
      ]),
    ])
    const node = {
      values: {},
      dynamic: {
        'mode': { selected: 'multi' },
        'mode.[multi].images': { members: ['m0', 'm1'] },
      },
    }
    const e = elaborateInterface(schema, node)
    expect(e.diagnostics).toEqual([])
    const inputs = elabInputsOf(e)
    expect(inputs.map((i) => [elabKeyOf(i.address), i.apiName])).toEqual([
      ['mode', 'mode'],
      ['mode.[multi].images.item#m0', 'mode.images.image0'],
      ['mode.[multi].images.item#m1', 'mode.images.image1'],
      ['mode.[multi].images.item#m2', undefined], // ghost
    ])
  })

  it('a combo inside a slot only elaborates while the slot is connected', () => {
    const schema = schemaOf([
      slotConstruct('model', [comboConstruct('mode', [{ key: 'a', inputs: [intInput('x')] }])]),
    ])
    expect(elabInputsOf(elaborateInterface(schema, noState))).toHaveLength(1)
    const e = elaborateInterface(schema, noState, connectedInputs(['model']))
    expect(elabInputsOf(e).map((i) => i.address.port)).toEqual(['model', 'model.mode', 'model.mode.[a].x'])
  })

  it('runaway nesting is cut off with ONE budget error, not a stack overflow', () => {
    let inner: InputSpec = intInput('leaf')
    for (let i = 0; i < 40; i++) inner = comboConstruct(`c${i}`, [{ key: 'k', inputs: [inner] }])
    const e = elaborateInterface(schemaOf([inner]), noState)
    expect(e.diagnostics.filter((d) => d.code === 'elab.budget.depth')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Recursive elaboration: Autogrow-in-Autogrow
// ---------------------------------------------------------------------------

/**
 * Outer family 'items' (grouped template): each member stamps an image plus
 * an INNER family 'sub' of latents. The schema shape custom packs actually
 * build ("each item takes an image and any number of latents").
 */
const nestedFamily = (opts: { outerMin?: number; innerMin?: number } = {}): InputSpec => ({
  kind: 'input',
  id: 'items',
  type: { kind: 'wildcard' },
  optional: false,
  dynamic: {
    kind: 'autogrow',
    template: [
      socketInput('image', 'IMAGE'),
      {
        kind: 'input',
        id: 'sub',
        type: { kind: 'wildcard' },
        optional: true,
        dynamic: {
          kind: 'autogrow',
          template: [socketInput('item', 'LATENT')],
          naming: { kind: 'prefix', prefix: 'g', min: opts.innerMin ?? 0, max: 3 },
        },
      },
    ],
    naming: { kind: 'prefix', prefix: 'item', min: opts.outerMin ?? 1, max: 3 },
  },
})

/** Two real outer members with independent inner families. */
const nestedState = {
  values: {},
  dynamic: {
    items: {
      members: ['m0', 'm1'],
      memberState: {
        m0: { 'items.sub': { members: ['m10', 'm11'] } },
        m1: { 'items.sub': { members: ['m5'] } },
      },
    },
  },
}

describe('autogrow-in-autogrow', () => {
  it('nested members get full member-path identity, never flattened or ordinal-based', () => {
    const e = elaborateInterface(schemaOf([nestedFamily()]), nestedState)
    expect(e.diagnostics).toEqual([])
    const inputs = elabInputsOf(e)
    expect(inputs.map((i) => [elabKeyOf(i.address), i.apiName])).toEqual([
      // outer m0: image + inner members m10, m11 + inner ghost m12 (fresh
      // ids continue past the highest used suffix - never recycled)
      ['items.image#m0', 'items.item0.image'],
      ['items.sub.item#m0#m10', 'items.item0.sub.g0'],
      ['items.sub.item#m0#m11', 'items.item0.sub.g1'],
      ['items.sub.item#m0#m12', undefined], // inner ghost under a real member
      // outer m1: image + inner member m5 + inner ghost m6
      ['items.image#m1', 'items.item1.image'],
      ['items.sub.item#m1#m5', 'items.item1.sub.g0'],
      ['items.sub.item#m1#m6', undefined], // inner ghost
      // outer trailing ghost m2: image ONLY - no inner tree beneath a ghost
      ['items.image#m2', undefined],
    ])
    // spec.id always equals the packed elaborated key (unique within node).
    for (const i of inputs) expect(i.spec.id).toBe(elabKeyOf(i.address))
  })

  it('reordering outer members moves ordinals/api names, never nested identity or state', () => {
    const reordered = {
      values: {},
      dynamic: {
        items: {
          members: ['m1', 'm0'], // swapped
          memberState: nestedState.dynamic.items.memberState,
        },
      },
    }
    const inputs = elabInputsOf(elaborateInterface(schemaOf([nestedFamily()]), reordered))
    // m1 is now ordinal 0 (api item0) but still owns ONLY its inner member m5.
    expect(inputs.map((i) => [elabKeyOf(i.address), i.apiName])).toEqual([
      ['items.image#m1', 'items.item0.image'],
      ['items.sub.item#m1#m5', 'items.item0.sub.g0'],
      ['items.sub.item#m1#m6', undefined],
      ['items.image#m0', 'items.item1.image'],
      ['items.sub.item#m0#m10', 'items.item1.sub.g0'],
      ['items.sub.item#m0#m11', 'items.item1.sub.g1'],
      ['items.sub.item#m0#m12', undefined],
      ['items.image#m2', undefined],
    ])
  })

  it('ghost rules: at most one ghost ancestor per address; nothing beneath a ghost compiles', () => {
    const e = elaborateInterface(schemaOf([nestedFamily({ innerMin: 1 })]), noState)
    const inputs = elabInputsOf(e)
    for (const i of inputs) {
      const ghosts = (i.ancestry ?? []).filter((a) => a.ghost).length
      expect(ghosts, elabKeyOf(i.address)).toBeLessThanOrEqual(1)
      if (ghosts > 0) {
        expect(i.apiName, elabKeyOf(i.address)).toBeUndefined()
        expect(i.spec.optional, elabKeyOf(i.address)).toBe(true)
      }
    }
    // innerMin=1 synthesizes one real-shaped inner row even under the outer
    // ghost - but it inherits the outer's ghostness (single ghost ancestor)
    // and the inner family emits NO ghost affordance of its own there.
    const underGhost = inputs.filter((i) => i.ancestry?.[0]?.ghost)
    expect(underGhost.map((i) => elabKeyOf(i.address))).toEqual([
      'items.image#m1',
      'items.sub.item#m1#m0', // synthesized inner minimum, no trailing sibling
    ])
  })

  it('a connection on any slot of the outer ghost group promotes it, re-enabling its inner ghost', () => {
    const e = elaborateInterface(
      schemaOf([nestedFamily()]),
      noState,
      connectedInputs(['items.image', 'm1']), // fresh node: m0 synthesized real, m1 = outer ghost
    )
    const keys = elabInputsOf(e).map((i) => elabKeyOf(i.address))
    // Promoted m1 stamps its full group, including the inner ghost affordance.
    expect(keys).toContain('items.sub.item#m1#m0')
    const image = elabInputsOf(e).find((i) => elabKeyOf(i.address) === 'items.image#m1')!
    expect(image.origin).toEqual({ kind: 'member', construct: 'items', ordinal: 1 }) // not ghost
  })

  it('an inner ghost promotes by a full-path connection without touching siblings', () => {
    const e = elaborateInterface(
      schemaOf([nestedFamily()]),
      nestedState,
      connectedInputs(['items.sub.item', 'm0', 'm12']), // m0's inner ghost (fresh id past m10/m11)
    )
    const byKey = new Map(elabInputsOf(e).map((i) => [elabKeyOf(i.address), i]))
    expect(byKey.get('items.sub.item#m0#m12')!.apiName).toBe('items.item0.sub.g2')
    expect(byKey.get('items.sub.item#m0#m12')!.ancestry!.every((a) => !a.ghost)).toBe(true)
    // Sibling member m1's inner ghost is untouched.
    expect(byKey.get('items.sub.item#m1#m6')!.ancestry!.some((a) => a.ghost)).toBe(true)
  })

  it('ancestry composes per family crossing, aligned with address.members, orthogonal to leaf role', () => {
    const inputs = elabInputsOf(elaborateInterface(schemaOf([nestedFamily()]), nestedState))
    const inner = inputs.find((i) => elabKeyOf(i.address) === 'items.sub.item#m0#m10')!
    expect(inner.ancestry).toEqual([
      { construct: 'items', member: 'm0', ordinal: 0 },
      { construct: 'items.sub', member: 'm10', ordinal: 0 },
    ])
    expect(inner.origin).toEqual({ kind: 'member', construct: 'items.sub', ordinal: 0 })
    const outer = inputs.find((i) => elabKeyOf(i.address) === 'items.image#m0')!
    expect(outer.ancestry).toEqual([{ construct: 'items', member: 'm0', ordinal: 0 }])
    // Top-level ports carry no ancestry at all.
    const flat = elabInputsOf(elaborateInterface(schemaOf([socketInput('image')]), noState))
    expect(flat[0]!.ancestry).toBeUndefined()
  })

  it('a combo inside a member keeps selector/branch roles; state and values are member-scoped', () => {
    const family: InputSpec = {
      kind: 'input',
      id: 'items',
      type: { kind: 'wildcard' },
      optional: false,
      dynamic: {
        kind: 'autogrow',
        template: [comboConstruct('mode', [{ key: 'a', inputs: [intInput('x')] }, { key: 'b', inputs: [] }])],
        naming: { kind: 'prefix', prefix: 'item', min: 1, max: 3 },
      },
    }
    const node = {
      values: {},
      dynamic: {
        items: {
          members: ['m0', 'm1'],
          memberState: { m1: { 'items.mode': { selected: 'b' } } },
        },
      },
    }
    const inputs = elabInputsOf(elaborateInterface(schemaOf([family]), node))
    const rows = inputs.map((i) => [elabKeyOf(i.address), i.origin.kind, i.derivedValue])
    expect(rows).toEqual([
      ['items.mode#m0', 'selector', 'a'], // default: no member state
      ['items.mode.[a].x#m0', 'branch', undefined], // branch value key is member-scoped
      ['items.mode#m1', 'selector', 'b'], // m1's own selection
      // The ghost member previews its full group shape, including the
      // combo's default active branch. Nothing under it compiles.
      ['items.mode#m2', 'selector', 'a'],
      ['items.mode.[a].x#m2', 'branch', undefined],
    ])
    const ghostBranch = inputs.find((i) => elabKeyOf(i.address) === 'items.mode.[a].x#m2')!
    expect(ghostBranch.apiName).toBeUndefined()
    const branch = inputs.find((i) => elabKeyOf(i.address) === 'items.mode.[a].x#m0')!
    expect(branch.ancestry).toEqual([{ construct: 'items', member: 'm0', ordinal: 0 }])
  })

  it('three-level nesting resolves state through chained member cursors', () => {
    const family: InputSpec = {
      kind: 'input',
      id: 'a',
      type: { kind: 'wildcard' },
      optional: false,
      dynamic: {
        kind: 'autogrow',
        template: [
          {
            kind: 'input',
            id: 'b',
            type: { kind: 'wildcard' },
            optional: true,
            dynamic: {
              kind: 'autogrow',
              template: [
                {
                  kind: 'input',
                  id: 'c',
                  type: { kind: 'wildcard' },
                  optional: true,
                  dynamic: {
                    kind: 'autogrow',
                    template: [socketInput('leaf', 'IMAGE')],
                    naming: { kind: 'prefix', prefix: 'z', min: 0, max: 2 },
                  },
                },
              ],
              naming: { kind: 'prefix', prefix: 'y', min: 0, max: 2 },
            },
          },
        ],
        naming: { kind: 'prefix', prefix: 'x', min: 0, max: 2 },
      },
    }
    const node = {
      values: {},
      dynamic: {
        a: {
          members: ['m1'],
          memberState: {
            m1: { 'a.b': { members: ['m2'], memberState: { m2: { 'a.b.c': { members: ['m3'] } } } } },
          },
        },
      },
    }
    const inputs = elabInputsOf(elaborateInterface(schemaOf([family]), node))
    const leaf = inputs.find((i) => elabKeyOf(i.address) === 'a.b.c.leaf#m1#m2#m3')
    expect(leaf).toBeDefined()
    expect(leaf!.apiName).toBe('a.x0.b.y0.c.z0')
    expect(leaf!.ancestry).toEqual([
      { construct: 'a', member: 'm1', ordinal: 0 },
      { construct: 'a.b', member: 'm2', ordinal: 0 },
      { construct: 'a.b.c', member: 'm3', ordinal: 0 },
    ])
  })

  it('dynamic output families recurse symmetrically with inputs', () => {
    const family: OutputSpec = {
      kind: 'output',
      id: 'results',
      type: { kind: 'wildcard' },
      dynamic: {
        kind: 'autogrow',
        template: [
          {
            kind: 'input',
            id: 'sub',
            type: { kind: 'wildcard' },
            optional: true,
            dynamic: {
              kind: 'autogrow',
              template: [socketInput('item', 'IMAGE')],
              naming: { kind: 'prefix', prefix: 'g', min: 0, max: 2 },
            },
          },
        ],
        naming: { kind: 'prefix', prefix: 'result', min: 1, max: 2 },
      },
    }
    const node = {
      values: {},
      dynamic: {
        results: { members: ['m0'], memberState: { m0: { 'results.sub': { members: ['m9'] } } } },
      },
    }
    const e = elaborateInterface(schemaOf([family]), node)
    expect(e.diagnostics).toEqual([])
    const outs = elabOutputsOf(e)
    expect(outs.map((o) => elabKeyOf(o.address))).toEqual([
      'results.sub.item#m0#m9',
      'results.sub.item#m0#m10', // inner ghost (fresh id past m9)
      // outer ghost m1 stamps nothing (its only slot is the inner construct,
      // and ghosts emit no inner tree)
    ])
    expect(outs[0]!.ancestry).toEqual([
      { construct: 'results', member: 'm0', ordinal: 0 },
      { construct: 'results.sub', member: 'm9', ordinal: 0 },
    ])
  })

  it('fresh member ids skip orphaned memberState keys (stale state is never resurrected)', () => {
    const node = {
      values: {},
      dynamic: {
        images: {
          members: ['m0'],
          // Orphaned entry (member removed, nested state left behind): its
          // id stays burned even though it is absent from `members` - a
          // freshly minted ghost must never inherit stale nested state.
          memberState: { m1: {} },
        },
      },
    }
    const inputs = elabInputsOf(elaborateInterface(schemaOf([autogrowFamily('images', { min: 1, max: 4 })]), node))
    expect(inputs.map((i) => elabKeyOf(i.address))).toEqual(['images.item#m0', 'images.item#m2'])
  })

  it('flat families are unchanged by the recursion machinery (regression pin)', () => {
    const node = { values: {}, dynamic: { images: { members: ['m0', 'm1'] } } }
    const inputs = elabInputsOf(elaborateInterface(schemaOf([autogrowFamily('images', { min: 1, max: 4 })]), node))
    expect(inputs.map((i) => [elabKeyOf(i.address), i.apiName])).toEqual([
      ['images.item#m0', 'images.image0'],
      ['images.item#m1', 'images.image1'],
      ['images.item#m2', undefined],
    ])
    expect(inputs[0]!.ancestry).toEqual([{ construct: 'images', member: 'm0', ordinal: 0 }])
  })
})

describe('elaboration budgets (hard, deterministic)', () => {
  it('item budget: one error, clean stop, no partial recursion beyond the cut', () => {
    const e = elaborateInterface(
      schemaOf([socketInput('a'), socketInput('b'), socketInput('c'), socketInput('d')]),
      noState,
      EMPTY_CONNECTIVITY,
      { budget: { maxItems: 2 } },
    )
    expect(e.diagnostics.filter((d) => d.code === 'elab.budget.items')).toHaveLength(1)
    expect(e.items).toHaveLength(2)
  })

  it('item budget counts sections, not just ports', () => {
    const e = elaborateInterface(
      schemaOf([
        { kind: 'section', id: 's1', displayName: 'S1' },
        { kind: 'section', id: 's2', displayName: 'S2' },
        socketInput('a'),
      ]),
      noState,
      EMPTY_CONNECTIVITY,
      { budget: { maxItems: 2 } },
    )
    expect(e.diagnostics.filter((d) => d.code === 'elab.budget.items')).toHaveLength(1)
    expect(e.items).toHaveLength(2)
  })

  it('member budget: nested growth stops with one error in declared/member order', () => {
    const e = elaborateInterface(schemaOf([nestedFamily()]), nestedState, EMPTY_CONNECTIVITY, {
      budget: { maxMembers: 3 },
    })
    expect(e.diagnostics.filter((d) => d.code === 'elab.budget.members')).toHaveLength(1)
    // Deterministic prefix: outer m0 (1) + inner m10, m11 (2, 3) - then stop.
    expect(elabInputsOf(e).map((i) => elabKeyOf(i.address))).toEqual([
      'items.image#m0',
      'items.sub.item#m0#m10',
      'items.sub.item#m0#m11',
    ])
  })

  it('defaults leave realistic nested schemas untouched', () => {
    const e = elaborateInterface(schemaOf([nestedFamily()]), nestedState)
    expect(e.diagnostics).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Dynamic outputs (symmetry) and unknown kinds
// ---------------------------------------------------------------------------

describe('dynamic outputs', () => {
  it('autogrow elaborates output families through the same handler', () => {
    const family: OutputSpec = {
      kind: 'output',
      id: 'results',
      type: { kind: 'wildcard' },
      dynamic: {
        kind: 'autogrow',
        template: [socketInput('item', 'IMAGE')],
        naming: { kind: 'prefix', prefix: 'result', min: 1, max: 3 },
      },
    }
    const node = { values: {}, dynamic: { results: { members: ['m0', 'm1'] } } }
    const e = elaborateInterface(schemaOf([family]), node)
    const outs = elabOutputsOf(e)
    expect(outs.map((o) => [o.address.members, o.spec.displayName])).toEqual([
      [['m0'], 'result0'],
      [['m1'], 'result1'],
      [['m2'], 'result2'], // ghost affordance, symmetric with inputs
    ])
    expect(outs[0]!.spec.type).toEqual({ kind: 'concrete', name: 'IMAGE' })
    expect(e.outputMembers).toEqual({ results: ['m0', 'm1'] })
  })

  it('combo/slot on an output is diagnosed and elaborated inert', () => {
    const bad: OutputSpec = {
      kind: 'output',
      id: 'out',
      type: { kind: 'wildcard' },
      dynamic: { kind: 'dynamicCombo', options: [] },
    }
    const e = elaborateInterface(schemaOf([bad]), noState)
    expect(e.diagnostics.some((d) => d.code === 'elab.dynamic.unsupportedOnOutput')).toBe(true)
    expect(elabOutputsOf(e)).toHaveLength(1)
  })
})

describe('unknown dynamic kinds', () => {
  it('elaborates an inert port plus a diagnostic - never drops or corrupts', () => {
    const weird: InputSpec = {
      kind: 'input',
      id: 'future',
      type: { kind: 'wildcard' },
      optional: false,
      dynamic: { kind: 'holographic' } as never,
    }
    const e = elaborateInterface(schemaOf([weird, socketInput('image')]), noState)
    expect(e.diagnostics.some((d) => d.code === 'elab.dynamic.unknownKind')).toBe(true)
    const inputs = elabInputsOf(e)
    expect(inputs.map((i) => i.address.port)).toEqual(['future', 'image'])
    expect(inputs[0]!.origin).toEqual({ kind: 'unknown', construct: 'future' })
  })

  it('a registered custom handler takes over the kind', () => {
    const custom: DynamicKindHandler = {
      kind: 'holographic',
      elaborateInput(ctx, item, _dyn, scope) {
        ctx.emit(
          {
            kind: 'input',
            address: { port: item.id },
            apiName: item.id,
            spec: { kind: 'input', id: item.id, type: { kind: 'concrete', name: 'HOLO' }, optional: true },
            origin: { kind: 'static' },
          },
          scope,
        )
      },
    }
    const weird: InputSpec = {
      kind: 'input',
      id: 'future',
      type: { kind: 'wildcard' },
      optional: false,
      dynamic: { kind: 'holographic' } as never,
    }
    const e = elaborateInterface(schemaOf([weird]), noState, EMPTY_CONNECTIVITY, {
      handlers: { ...defaultDynamicHandlers, holographic: custom },
    })
    expect(e.diagnostics).toEqual([])
    expect(elabInputsOf(e)[0]!.spec.type).toEqual({ kind: 'concrete', name: 'HOLO' })
  })
})

// ---------------------------------------------------------------------------
// Connectivity facts
// ---------------------------------------------------------------------------

describe('buildGraphConnectivity', () => {
  it('counts tap-only and mixed port/tap producers without widening targets', () => {
    const def = {
      id: 'g0',
      nodes: {
        tapOnly: { id: 'tapOnly', type: 'Widget', values: {} },
        mixed: { id: 'mixed', type: 'Widget', values: {} },
        sink: { id: 'sink', type: 'Sink', values: {} },
      },
      links: {
        tapOnly: { id: 'tapOnly', from: { node: 'tapOnly', tap: 'value' }, to: { node: 'sink', port: 'a' } },
        mixedPort: { id: 'mixedPort', from: { node: 'mixed', port: 'value' }, to: { node: 'sink', port: 'b' } },
        mixedTap: { id: 'mixedTap', from: { node: 'mixed', tap: 'value' }, to: { node: 'sink', port: 'c' } },
      },
      nets: {},
      reroutes: {},
      nextOrdinal: 1,
    } as unknown as GraphDef
    const facts = buildGraphConnectivity(def)
    expect(facts(asNodeId('tapOnly')).isOutputConnected('value')).toBe(true)
    expect(facts(asNodeId('mixed')).isOutputConnected('value')).toBe(true)
    expect(facts(asNodeId('tapOnly')).isInputConnected('value')).toBe(false)
    expect(facts(asNodeId('sink')).isInputConnected('a')).toBe(true)
  })

  it('does not infer members or phantom connectivity from stale tap producers', () => {
    const def = {
      id: 'g0',
      nodes: { real: { id: 'real', type: 'Widget', values: {} } },
      links: {
        stale: { id: 'stale', from: { node: 'missing', tap: 'value' }, to: { node: 'real', port: 'in' } },
        malformedMember: { id: 'malformedMember', from: { node: 'real', tap: 'value', members: ['m0'] }, to: { node: 'real', port: 'in2' } },
        empty: { id: 'empty', from: { node: 'real', tap: '' }, to: { node: 'real', port: 'in3' } },
      },
      nets: {},
      reroutes: {},
      nextOrdinal: 1,
    } as unknown as GraphDef
    const facts = buildGraphConnectivity(def)
    expect(facts(asNodeId('missing')).isOutputConnected('value')).toBe(false)
    expect(facts(asNodeId('real')).isOutputConnected('value')).toBe(false)
    expect(facts(asNodeId('real')).isOutputConnected('value', [asDynamicMemberId('m0')])).toBe(false)
  })

  it('indexes links and nets once, member-aware, ignoring reroute endpoints', () => {
    const def = {
      id: 'g0',
      nodes: {},
      links: {
        l0: { id: 'l0', from: { node: 'a', port: 'out0' }, to: { node: 'b', port: 'images.item', members: ['m1'] } },
        l1: { id: 'l1', from: { node: 'a', port: 'out0' }, to: { reroute: 'r0' } },
        l2: { id: 'l2', from: { reroute: 'r0' }, to: { node: 'b', port: 'model' } },
      },
      nets: {
        n0: { id: 'n0', name: 'vae', source: { node: 'c', port: 'out0' }, sinks: [{ node: 'b', port: 'vae' }] },
      },
      reroutes: { r0: { id: 'r0' } },
      nextOrdinal: 3,
    } as unknown as GraphDef
    const facts = buildGraphConnectivity(def)
    const b = facts(asNodeId('b'))
    expect(b.isInputConnected('images.item', [asDynamicMemberId('m1')])).toBe(true)
    expect(b.isInputConnected('images.item')).toBe(false) // member-addressed, not family-wide
    expect(b.isInputConnected('model')).toBe(true) // reroute-driven links still land on the input
    expect(b.isInputConnected('vae')).toBe(true) // net sinks count
    expect(facts(asNodeId('a')).isOutputConnected('out0')).toBe(true)
    expect(facts(asNodeId('zzz'))).toBe(facts(asNodeId('yyy'))) // unconnected nodes share the constant
  })

  it('distinguishes nested member paths by every segment', () => {
    const def = {
      id: 'g0',
      nodes: {},
      links: {
        l0: { id: 'l0', from: { node: 'a', port: 'out0' }, to: { node: 'b', port: 'items.sub', members: ['m0', 'g0'] } },
      },
      nets: {},
      reroutes: {},
      nextOrdinal: 1,
    } as unknown as GraphDef
    const b = buildGraphConnectivity(def)(asNodeId('b'))
    const at = (...path: string[]) => b.isInputConnected('items.sub', path.map(asDynamicMemberId))
    expect(at('m0', 'g0')).toBe(true)
    expect(at('m0', 'g1')).toBe(false) // sibling inner member
    expect(at('m1', 'g0')).toBe(false) // sibling outer member
    expect(at('m0')).toBe(false) // prefix is not the leaf
    expect(at('g0')).toBe(false) // segment order matters
    expect(b.isInputConnected('items.sub')).toBe(false) // member-addressed, not family-wide
  })
})

describe('elabKeyOf nested addresses', () => {
  it('emits one #-joined segment per path level, injectively', () => {
    expect(elabKeyOf({ port: 'items.sub' })).toBe('items.sub')
    expect(elabKeyOf({ port: 'items.sub', members: [asDynamicMemberId('m0')] })).toBe('items.sub#m0')
    expect(elabKeyOf({ port: 'items.sub', members: ['m0', 'g0'].map(asDynamicMemberId) })).toBe('items.sub#m0#g0')
    const keys = [
      elabKeyOf({ port: 'items.sub', members: ['m0', 'g0'].map(asDynamicMemberId) }),
      elabKeyOf({ port: 'items.sub', members: ['m0', 'g1'].map(asDynamicMemberId) }),
      elabKeyOf({ port: 'items.sub', members: ['m1', 'g0'].map(asDynamicMemberId) }),
      elabKeyOf({ port: 'items.sub', members: [asDynamicMemberId('m0')] }),
    ]
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('stays injective when components contain the separator', () => {
    // '#' inside a port or member id must not read as a path boundary.
    expect(elabKeyOf({ port: 'p#a', members: [asDynamicMemberId('b')] })).not.toBe(
      elabKeyOf({ port: 'p', members: ['a', 'b'].map(asDynamicMemberId) }),
    )
    expect(elabKeyOf({ port: 'p%23a' })).not.toBe(elabKeyOf({ port: 'p#a' }))
  })
})

// ---------------------------------------------------------------------------
// Determinism and scale
// ---------------------------------------------------------------------------

describe('determinism and scale', () => {
  it('is deterministic: same inputs, structurally identical output', () => {
    const schema = schemaOf([
      autogrowFamily('images', { min: 1, max: 4 }),
      comboConstruct('mode', [{ key: 'a', inputs: [intInput('x')] }]),
      slotConstruct('model', [intInput('s')]),
    ])
    const node = { values: {}, dynamic: { images: { members: ['m0', 'm1'] } } }
    const facts = connectedInputs(['model'])
    expect(elaborateInterface(schema, node, facts)).toEqual(elaborateInterface(schema, node, facts))
  })

  it('elaborates a 100-member family linearly (structure check, not a benchmark)', () => {
    const members = Array.from({ length: 99 }, (_, i) => `m${i}`)
    const node = { values: {}, dynamic: { images: { members } } }
    const e = elaborateInterface(schemaOf([autogrowFamily('images', { min: 0, max: 100 })]), node)
    const inputs = elabInputsOf(e)
    expect(inputs).toHaveLength(100) // 99 + ghost
    expect(inputs[98]!.apiName).toBe('images.image98')
    expect(inputs[99]!.origin).toMatchObject({ ghost: true })
    expect(e.diagnostics).toEqual([])
  })
})
