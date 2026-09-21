/**
 * Replacement rules against GOLDEN payloads emitted by the real backend
 * encoder (dinkster_schema schema_to_wire/rule_to_wire at Dinkster a479dfee,
 * schema wire v21; regenerate with
 * scripts/generate_replacement_goldens.py there, drift-locked backend-side
 * by tests/test_goldens.py).
 *
 * Contract under test: the backend mirrors our ReplacementRule vocabulary
 * field-for-field, so encoder-authored rules must (a) decode with zero
 * diagnostics, (b) survive normalization BYTE-FOR-BYTE (rules are closed
 * declarative data - the decoder validates, never rewrites), and (c) drive
 * the real planner/scanner/command pipeline end to end: predicates match,
 * transforms compute, chains hop sequentially, one dispatch = one undo.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import type { GraphDef, Json, WorkflowDocument } from '../src/format/document.js'
import { asGraphDefId, asLineageId, asLinkId, asNodeId, asPortId } from '../src/ids.js'
import type { MappingSource, ReplacementPredicate, ReplacementRule } from '../src/replace/model.js'
import { createReplacementRegistry } from '../src/replace/registry.js'
import { registerSchemaRules, replacementInvocation, scanReplacements } from '../src/replace/scan.js'
import { resolveDeprecationPointer } from '../src/schema/deprecation.js'
import {
  parseDinksterNodes,
  searchVisibilityOf,
  type DinksterWireSchema,
  type NodeSchema,
} from '../src/index.js'

// ---------------------------------------------------------------------------
// Fixture loading: the goldens are {"schemas": [schema_wire, ...]} (each wire
// entry self-describes its nodeType); adapt into the GET /api/nodes payload
// shape without touching the schema objects themselves.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const loadGolden = (name: string): { raw: readonly DinksterWireSchema[]; schemas: ReadonlyMap<string, NodeSchema> } => {
  const raw = (
    JSON.parse(readFileSync(join(here, `../fixtures/replacements/${name}.json`), 'utf8')) as {
      schemas: (DinksterWireSchema & { nodeType: string })[]
    }
  ).schemas
  const { schemas, diagnostics } = parseDinksterNodes({
    schemaVersion: 21,
    nodes: Object.fromEntries(raw.map((s) => [s.nodeType, s])),
  })
  expect(diagnostics, `${name}.json must decode clean`).toEqual([])
  return { raw, schemas }
}

const vocabulary = loadGolden('vocabulary')
const chain = loadGolden('chain')
const combo = loadGolden('combo')

const schemaOf = (g: typeof vocabulary, type: string): NodeSchema => {
  const s = g.schemas.get(type)
  expect(s, `schema '${type}'`).toBeDefined()
  return s!
}

// ---------------------------------------------------------------------------
// Document builders (same shapes as replacement.test.ts)
// ---------------------------------------------------------------------------

const port = (node: string, portId: string) => ({ node: asNodeId(node), port: asPortId(portId) })

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

function doc(graphs: Record<string, GraphDef>, root = 'g0'): WorkflowDocument {
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: asLineageId('lin1'),
    root: asGraphDefId(root),
    graphs,
    view: { graphs: {} },
  }
}

const node = (id: string, type: string, values: Record<string, Json> = {}) => ({
  id: asNodeId(id),
  type,
  values,
})

const link = (id: string, from: object, to: object) => ({ id: asLinkId(id), from, to }) as GraphDef['links'][string]

/** Registry seeded with every rule the golden's schemas ship. */
function registryOf(g: typeof vocabulary) {
  const registry = createReplacementRegistry()
  expect(registerSchemaRules(registry, g.schemas.values())).toEqual([])
  return registry
}

const resolveIn =
  (g: typeof vocabulary) =>
  (type: string): NodeSchema | undefined =>
    g.schemas.get(type)

// ---------------------------------------------------------------------------
// vocabulary.json: every predicate/mapping/transform variant, one rule
// ---------------------------------------------------------------------------

describe('vocabulary golden: decode', () => {
  it('rules survive frontend normalization byte-for-byte', () => {
    for (const g of [vocabulary, chain, combo]) {
      for (const wire of g.raw) {
        const decoded = g.schemas.get(String(wire.nodeType))!.replacements
        if (wire.replacements === undefined) expect(decoded).toBeUndefined()
        else expect(decoded).toEqual(wire.replacements)
      }
    }
  })

  it('the carrier is the successor; the rule self-describes its predecessor', () => {
    const rules = schemaOf(vocabulary, 'fixture.modern').replacements!
    expect(rules).toHaveLength(1)
    expect(rules[0]!.from).toBe('fixture.legacy')
    expect(rules[0]!.note).toBe('renamed and re-ranged in fixture pack 2.0')
    expect(schemaOf(vocabulary, 'fixture.legacy').replacements).toBeUndefined()
    expect(schemaOf(vocabulary, 'fixture.alternate').replacements).toBeUndefined()
  })

  it('exercises every predicate kind (always spelled as the omitted-when fallback)', () => {
    const rule = schemaOf(vocabulary, 'fixture.modern').replacements![0]!
    const kinds = new Set<string>()
    const walk = (p: ReplacementPredicate): void => {
      kinds.add(p.kind)
      if (p.kind === 'not') walk(p.of)
      if (p.kind === 'all' || p.kind === 'any') p.of.forEach(walk)
    }
    for (const c of rule.cases) if (c.when) walk(c.when)
    expect([...kinds].sort()).toEqual(['all', 'any', 'inputConnected', 'not', 'valueEquals', 'valuePresent'])
    // 'always' rides as the omitted `when` on the required fallback.
    expect(rule.cases.at(-1)!.when).toBeUndefined()
  })

  it('exercises every mapping kind and both transforms, offset present and omitted', () => {
    const rule = schemaOf(vocabulary, 'fixture.modern').replacements![0]!
    const mappings = rule.cases.flatMap((c) => Object.values(c.inputs ?? {}))
    const byKind = (kind: MappingSource['kind']) => mappings.filter((m) => m.kind === kind)
    expect(byKind('copy').length).toBeGreaterThan(0)
    expect(byKind('link').length).toBeGreaterThan(0)
    expect(byKind('constant').length).toBeGreaterThan(0)
    const transforms = byKind('value').flatMap((m) => (m.kind === 'value' && m.transform ? [m.transform] : []))
    expect(transforms).toContainEqual({ kind: 'scale', factor: 0.01, offset: 0.5 })
    expect(transforms).toContainEqual({ kind: 'scale', factor: 2.0 }) // offset omitted at 0
    expect(transforms).toContainEqual({ kind: 'enumRename', map: { fast: 'draft', slow: 'final' } })
  })

  it('preserves guarded multi-successor fan-out: case.to is not constrained to the carrier', () => {
    const rule = schemaOf(vocabulary, 'fixture.modern').replacements![0]!
    expect(rule.cases.map((c) => c.to)).toEqual(['fixture.modern', 'fixture.alternate', 'fixture.modern'])
  })
})

describe('combo golden: wire v21 widget adjuncts and socket identity', () => {
  it('decodes COMBO and MULTI_COMBO presentation with exact list identity', () => {
    const schema = schemaOf(combo, 'fixture.combo-contract')
    const input = schema.items.find((item) => item.kind === 'input')
    const output = schema.items.find((item) => item.kind === 'output')
    expect(input).toMatchObject({
      type: { kind: 'concrete', name: 'core.combo' },
      widget: {
        widgetType: 'COMBO',
        options: { options: ['alpha', 'beta'] },
        remote: { route: '/api/choices/fixture.combo', refreshButton: true },
        controller: 'after_generate',
        controllerInitial: 'randomize',
      },
    })
    expect(output).toMatchObject({ type: { kind: 'concrete', name: 'core.combo' } })
    expect(input).toMatchObject({ widget: { default: 'alpha' } })
    expect(typeof (input?.kind === 'input' ? input.widget?.default : undefined)).toBe('string')
    const prompt = schema.items.find((item) => item.kind === 'input' && item.id === 'prompt')
    const scale = schema.items.find((item) => item.kind === 'input' && item.id === 'scale')
    const color = schema.items.find((item) => item.kind === 'input' && item.id === 'color')
    expect(prompt).toMatchObject({
      type: { kind: 'concrete', name: 'core.string' },
      widget: {
        widgetType: 'STRING',
        options: { multiline: true, placeholder: 'Describe an image', dynamicPrompts: true },
        representations: {
          default: 'multiline',
          userSwitchable: true,
          representations: [
            { id: 'single-line', widget: { options: { multiline: false, placeholder: 'Describe an image', dynamicPrompts: false } } },
            { id: 'multiline', widget: { options: { multiline: true, placeholder: 'Describe an image', dynamicPrompts: true } } },
          ],
        },
      },
    })
    expect(scale).toMatchObject({ widget: { widgetType: 'FLOAT', options: { round: 0.001 } } })
    expect(color).toMatchObject({
      type: { kind: 'concrete', name: 'core.string' },
      widget: { widgetType: 'COLOR', options: {} },
    })
    const providers = schema.items.find((item) => item.kind === 'input' && item.id === 'providers')
    expect(providers).toEqual(expect.objectContaining({
      type: { kind: 'list', element: { kind: 'concrete', name: 'core.combo' } },
      widget: {
        widgetType: 'MULTI_COMBO',
        options: {
          options: ['beta', 'alpha', 'beta'],
          placeholder: 'Select providers',
          chip: false,
        },
        remote: {
          route: '/api/choices/fixture.providers',
          refreshButton: true,
          controlAfterRefresh: 'last',
          timeoutMs: 4096,
          maxRetries: 2,
          refreshMs: 0,
        },
        default: ['beta', 'alpha', 'beta'],
      },
    }))
    expect(providers?.kind === 'input' ? providers.widget?.default : undefined).toEqual(['beta', 'alpha', 'beta'])
    const providersOutput = schema.items.find((item) => item.kind === 'output' && item.id === 'providers')
    expect(providersOutput).toMatchObject({
      type: { kind: 'list', element: { kind: 'concrete', name: 'core.combo' } },
    })
    expect(JSON.stringify(combo.raw)).not.toContain('comboSource')
  })
})

describe('vocabulary golden: planning against real documents', () => {
  const registry = registryOf(vocabulary)
  const resolve = resolveIn(vocabulary)

  /** legacy node wired image-in + frames-in + both outputs consumed. */
  function wiredLegacy(values: Record<string, Json>): WorkflowDocument {
    return doc({
      g0: graph({
        id: 'g0',
        nodes: {
          src: node('src', 'Producer'),
          old: node('old', 'fixture.legacy', values),
          dst: node('dst', 'Consumer'),
        },
        links: {
          l1: link('l1', port('src', 'out'), port('old', 'image')),
          l2: link('l2', port('src', 'list'), port('old', 'frames')),
          l3: link('l3', port('old', 'result'), port('dst', 'in')),
          l4: link('l4', port('old', 'mask'), port('dst', 'in2')),
        },
      }),
    })
  }

  it('case 0: deep predicate matches; all four mapping kinds execute; apply + undo', () => {
    const d = wiredLegacy({ strength: 40, mode: 'fast' })
    const items = scanReplacements(d, registry, resolve)
    expect(items).toHaveLength(1)
    const item = items[0]!
    expect(item.status).toBe('terminal')
    expect(item.terminalType).toBe('fixture.modern')
    expect(item.hops).toHaveLength(1)
    const plan = item.hops[0]!.plan
    expect(plan.caseIndex).toBe(0)
    expect(plan.values['intensity']).toBe(40 * 0.01 + 0.5) // scale with offset
    expect(plan.values['quality']).toBe('draft') // enumRename fast -> draft
    expect(plan.values['caption']).toBe('migrated') // constant
    expect(item.safe).toBe(true)

    const store = new DocumentStore(d, coreCommandRegistry())
    expect(store.dispatch(replacementInvocation([item])!).ok).toBe(true)
    const after = store.doc.graphs.g0!
    expect(after.nodes.old!.type).toBe('fixture.modern')
    // copy moved the image connection; link moved frames; outputs rewired.
    expect(after.links.l1!.to).toEqual(port('old', 'picture'))
    expect(after.links.l2!.to).toEqual(port('old', 'frames'))
    expect(after.links.l3!.from).toEqual(port('old', 'output'))
    expect(after.links.l4!.from).toEqual(port('old', 'alpha'))
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(d)
  })

  it('case 1: guarded fan-out routes to the alternate successor, not the carrier', () => {
    // No image connection (case 0 fails) and enabled === false (case 1 matches).
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { old: node('old', 'fixture.legacy', { strength: 3, enabled: false }) },
      }),
    })
    const item = scanReplacements(d, registry, resolve)[0]!
    expect(item.hops[0]!.plan.caseIndex).toBe(1)
    expect(item.terminalType).toBe('fixture.alternate')
    expect(item.hops[0]!.plan.values['amount']).toBe(6) // scale x2, no offset
    expect(item.safe).toBe(true)
  })

  it('fallback: no predicate matches, the unconditional last case still plans', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        // valueEquals(mode,'fast') false, valuePresent(label) true kills the
        // any-branch; image unconnected kills case 0 anyway; enabled !== false.
        nodes: { old: node('old', 'fixture.legacy', { mode: 'slow', label: 'x', enabled: true }) },
      }),
    })
    const item = scanReplacements(d, registry, resolve)[0]!
    expect(item.hops[0]!.plan.caseIndex).toBe(2)
    expect(item.terminalType).toBe('fixture.modern')
  })
})

// ---------------------------------------------------------------------------
// chain.json: A -> B -> C, pointers AND executable hops
// ---------------------------------------------------------------------------

describe('chain golden: deprecation + visibility + rules on one schema', () => {
  it('decodes the combined fixture: message/since/pointer + explicit visibility', () => {
    const a = schemaOf(chain, 'fixture.chain-a')
    expect(a.deprecation).toEqual({
      message: 'chain-a is superseded; use chain-b',
      since: '1.2.0',
      replacement: 'fixture.chain-b',
    })
    expect(searchVisibilityOf(a)).toBe('deprecated')
    const b = schemaOf(chain, 'fixture.chain-b')
    expect(b.deprecation?.replacement).toBe('fixture.chain-c')
    expect(searchVisibilityOf(b)).toBe('hidden')
    expect(b.replacements).toHaveLength(1)
    const c = schemaOf(chain, 'fixture.chain-c')
    expect(c.deprecation).toBeUndefined()
    expect(searchVisibilityOf(c)).toBe('normal')
  })

  it('resolves the A -> B -> C pointer chain to terminal C', () => {
    const resolved = resolveDeprecationPointer(schemaOf(chain, 'fixture.chain-a'), resolveIn(chain))
    expect(resolved).toEqual({
      terminal: 'fixture.chain-c',
      path: ['fixture.chain-b', 'fixture.chain-c'],
      status: 'ok',
    })
  })

  it('plans and applies the executable chain: hop 2 reads hop 1 transformed state', () => {
    const registry = registryOf(chain)
    const resolve = resolveIn(chain)
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { n: node('n', 'fixture.chain-a', { level: 3, mode: 'lo' }), dst: node('dst', 'Consumer') },
        links: { l1: link('l1', port('n', 'value'), port('dst', 'in')) },
      }),
    })
    const items = scanReplacements(d, registry, resolve)
    expect(items).toHaveLength(1)
    const item = items[0]!
    expect(item.status).toBe('terminal')
    expect(item.terminalType).toBe('fixture.chain-c')
    expect(item.hops.map((h) => `${h.plan.from}->${h.plan.to}`)).toEqual([
      'fixture.chain-a->fixture.chain-b',
      'fixture.chain-b->fixture.chain-c',
    ])
    // hop 1: level scaled x10 into amount; mode copied into preset.
    expect(item.hops[0]!.plan.values).toEqual({ amount: 30, preset: 'lo' })
    // hop 2 planned against hop 1's OUTPUT: amount=30 and preset='lo' exist
    // only there; enumRename lo -> low proves the vocabulary hop ran second.
    expect(item.hops[1]!.plan.values).toEqual({ amount: 30, profile: 'low' })
    expect(item.safe).toBe(true)

    const store = new DocumentStore(d, coreCommandRegistry())
    expect(store.dispatch(replacementInvocation([item])!).ok).toBe(true)
    expect(store.revision).toBe(1) // both hops, one revision
    const n = store.doc.graphs.g0!.nodes.n!
    expect(n.type).toBe('fixture.chain-c')
    expect(n.values).toEqual({ amount: 30, profile: 'low' })
    expect(store.doc.graphs.g0!.links.l1!.from).toEqual(port('n', 'value')) // survived both output maps
    expect(store.undo()).toBe(true) // one undo step restores A
    expect(store.doc).toEqual(d)
  })
})
