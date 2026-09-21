/**
 * Synthesized legacy-name migration rules (replace/alias-rules.ts). The
 * contract under test:
 * - each (schema, alias) pair yields one rule: rename to the canonical type,
 *   identity-copy every static input, remap positional 'out{i}' onto the
 *   i-th static output
 * - self-aliases, aliases colliding with a real canonical id, and aliases
 *   two schemas claim are all skipped
 * - end to end: a document authored against the old object-info decoder
 *   (bare types + positional output ids) scans SAFE against native
 *   namespaced schemas, applies in one batch, and then compiles - the exact
 *   regression that shipped red/unrunnable stock workflows
 * - a legacy node bound to a subgraph boundary migrates its bindings
 *   through the rule's mappings in the same atomic transaction
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import { compile, type CompileInput } from '../src/compile/compile.js'
import type { WorkflowDocument } from '../src/format/document.js'
import { loadDocument } from '../src/format/migrate.js'
import { asConnectionId } from '../src/ids.js'
import { synthesizeAliasRules } from '../src/replace/alias-rules.js'
import { createReplacementRegistry } from '../src/replace/registry.js'
import { replacementInvocation, scanReplacements } from '../src/replace/scan.js'
import { parseDinksterNodes, type DinksterNodesPayload } from '../src/schema/dinkster-wire.js'
import type { InputSpec, NodeSchema, OutputSpec } from '../src/schema/model.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(root, rel), 'utf8'))

// ---------------------------------------------------------------------------
// Rule synthesis (unit)
// ---------------------------------------------------------------------------

const input = (id: string, extra?: Partial<InputSpec>): InputSpec => ({
  kind: 'input',
  id,
  type: { kind: 'concrete', name: 'IMAGE' },
  optional: false,
  ...extra,
})
const output = (id: string, extra?: Partial<OutputSpec>): OutputSpec => ({
  kind: 'output',
  id,
  type: { kind: 'concrete', name: 'IMAGE' },
  ...extra,
})
const schemaOf = (type: string, items: (InputSpec | OutputSpec)[], aliases?: string[]): NodeSchema => ({
  type,
  displayName: type,
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  items,
  ...(aliases !== undefined ? { aliases } : {}),
})

describe('synthesizeAliasRules', () => {
  it('derives rename + identity inputs + positional output map per alias', () => {
    const rules = synthesizeAliasRules([
      schemaOf('comfy.Thing', [input('a'), input('b'), output('image'), output('mask')], ['Thing', 'OldThing']),
    ])
    expect(rules.map((r) => r.from).sort()).toEqual(['OldThing', 'Thing'])
    const rule = rules.find((r) => r.from === 'Thing')!
    expect(rule.cases).toHaveLength(1)
    expect(rule.cases[0]!.to).toBe('comfy.Thing')
    expect(rule.cases[0]!.inputs).toEqual({
      a: { kind: 'copy', input: 'a' },
      b: { kind: 'copy', input: 'b' },
    })
    expect(rule.cases[0]!.outputs).toEqual({ image: 'out0', mask: 'out1' })
  })

  it('skips self-aliases, canonical collisions, and ambiguous claims', () => {
    const rules = synthesizeAliasRules([
      schemaOf('A', [output('image')], ['A']), // self: skipped
      schemaOf('B', [output('image')], ['C']), // collides with canonical C: skipped
      schemaOf('C', [output('image')]),
      schemaOf('D', [output('image')], ['Legacy']), // both claim 'Legacy': skipped
      schemaOf('E', [output('image')], ['Legacy']),
      schemaOf('F', [output('image')], ['OldF']), // fine
    ])
    expect(rules.map((r) => r.from)).toEqual(['OldF'])
  })

  it('never maps dynamic families', () => {
    const slot: InputSpec['dynamic'] = {
      kind: 'dynamicSlot',
      slotType: { kind: 'concrete', name: 'IMAGE' },
      inputs: [],
    }
    const rules = synthesizeAliasRules([
      schemaOf(
        'comfy.Dyn',
        [
          input('static'),
          input('family', { dynamic: slot }),
          output('image'),
          output('grow', { dynamic: slot }),
        ],
        ['Dyn'],
      ),
    ])
    expect(rules[0]!.cases[0]!.inputs).toEqual({ static: { kind: 'copy', input: 'static' } })
    expect(rules[0]!.cases[0]!.outputs).toEqual({ image: 'out0' })
  })
})

// ---------------------------------------------------------------------------
// End to end against native namespaced schemas (the shipped-defaults bug)
// ---------------------------------------------------------------------------

const payload = readJson('fixtures/dinkster-nodes-comfy.json') as DinksterNodesPayload
const { schemas: nativeSchemas } = parseDinksterNodes(payload)
const resolve = (type: string): NodeSchema | undefined => nativeSchemas.get(type)

const registry = () => {
  const reg = createReplacementRegistry()
  for (const rule of synthesizeAliasRules(nativeSchemas.values())) {
    expect(reg.register('core', rule)).toEqual([])
  }
  return reg
}

const loadWorkflow = (name: string): WorkflowDocument =>
  loadDocument(readJson(`fixtures/workflows/${name}.json`)).document!

const compileInput = (doc: WorkflowDocument): CompileInput => ({
  document: doc,
  revision: 1,
  resolve,
  scope: { kind: 'full' },
  connection: asConnectionId('c0'),
  schemaHash: 'test-schema-hash',
})

describe('legacy documents against native schemas', () => {
  it('exec-basic (bare types, out0 links) scans SAFE, applies, and compiles', () => {
    const doc = loadWorkflow('exec-basic')
    const items = scanReplacements(doc, registry(), resolve)
    expect(items).toHaveLength(2)
    expect(items.every((i) => i.safe)).toBe(true)
    expect(items.map((i) => i.terminalType).sort()).toEqual(['comfy.EmptyImage', 'comfy.PreviewImage'])

    const store = new DocumentStore(doc, coreCommandRegistry())
    expect(store.dispatch(replacementInvocation(items)!).ok).toBe(true)
    expect(store.revision).toBe(1) // one undo step
    const g0 = store.doc.graphs.g0!
    expect(g0.nodes.n0!.type).toBe('comfy.EmptyImage')
    expect(g0.nodes.n1!.type).toBe('comfy.PreviewImage')
    // The positional link endpoint moved onto the semantic output id.
    expect(g0.links.l2!.from).toEqual({ node: 'n0', port: 'image' })
    // Legacy stored values survive byte-for-byte.
    expect(g0.nodes.n0!.values).toMatchObject({ width: 64, height: 64, batch_size: 1, color: 0 })

    const result = compile(compileInput(store.doc))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['n0']!.class_type).toBe('comfy.EmptyImage')
    expect(result.artifact.prompt['n1']!.inputs['images']).toEqual(['n0', 0])
  })

  it('exec-subgraph: boundary bindings migrate with the legacy node (scan SAFE, apply, compile)', () => {
    const doc = loadWorkflow('exec-subgraph')
    const items = scanReplacements(doc, registry(), resolve)
    expect(items).toHaveLength(2)
    expect(items.every((i) => i.safe), JSON.stringify(items.flatMap((i) => i.diagnostics))).toBe(true)
    const bound = items.find((i) => i.graphId === 'g1' && i.nodeId === 'n0')!
    // Identity-copied 'color' binding needs no rewire; positional 'out0' does.
    expect(bound.plan!.boundaryRewires).toEqual([{ item: 'image', side: 'output', fromPort: 'out0', port: 'image' }])

    const store = new DocumentStore(doc, coreCommandRegistry())
    expect(store.dispatch(replacementInvocation(items)!).ok).toBe(true)
    const g1 = store.doc.graphs.g1!
    expect(g1.nodes.n0!.type).toBe('comfy.EmptyImage')
    expect(g1.boundary!.inputs[0]!.binds).toMatchObject({ node: 'n0', port: 'color' })
    expect(g1.boundary!.inputs[0]!.promoted).toBe(true)
    expect(g1.boundary!.outputs[0]!.binds).toMatchObject({ node: 'n0', port: 'image' })

    const result = compile(compileInput(store.doc))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Seed workflows (the shipped stock tabs) are LEGACY-form on purpose: bare
// class types + positional out{i} ports run as-is on a V1 ComfyUI backend
// (which serves only bare names, so canonical 'comfy.*' types could never
// resolve there), and auto-migrate to canonical native schemas on open
// against a Dinkster backend through the synthesized alias rules above. One
// portable fixture, both backend kinds; the native cost is a one-step,
// undoable, surfaced upgrade on first open.
// ---------------------------------------------------------------------------

describe('seed workflows', () => {
  it.each(['seed-basic', 'seed-subgraph'] as const)('%s migrates cleanly on native and compiles after migration', (name) => {
    const doc = loadWorkflow(name)
    // Every legacy-typed node scans as a SAFE migration (auto-applies
    // without review); alias RESOLUTION for rendering is pinned in the
    // client registry tests.
    const items = scanReplacements(doc, registry(), resolve)
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((i) => i.safe), JSON.stringify(items.flatMap((i) => i.diagnostics))).toBe(true)
    const store = new DocumentStore(doc, coreCommandRegistry())
    expect(store.dispatch(replacementInvocation(items)!).ok).toBe(true)
    for (const graph of Object.values(store.doc.graphs))
      for (const node of Object.values(graph.nodes)) {
        if (node.type.startsWith('#')) continue
        expect(node.type.startsWith('comfy.'), node.type).toBe(true)
      }
    const result = compile(compileInput(store.doc))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
  })
})
