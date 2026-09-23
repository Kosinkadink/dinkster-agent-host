/**
 * Environment stamping + drift diagnostics. The contract under test:
 * - the stamp is a RECORD, never identity: it never blocks loading, never
 *   joins the execution-semantic hash, and absence is fully valid
 * - sanitization is warn-and-drop: valid parts survive, malformed parts
 *   are named in ONE warning, and an empty husk is dropped entirely
 * - stamping is used-only on both axes (instantiated node types across
 *   ALL graph defs; packs attributing them) and returns undefined when no
 *   used type carries a signature (V1 backend) so callers preserve any
 *   existing stamp instead of overwriting it with an empty lie
 * - drift is advisory and precise: signature mismatch names the node type;
 *   a pack pin change with identical interfaces is info, not alarm
 */
import { describe, expect, it } from 'vitest'
import type { Diagnostic } from '../src/diagnostics.js'
import type { EnvironmentStamp, GraphDef, WorkflowDocument } from '../src/format/document.js'
import {
  environmentDrift,
  sanitizeEnvironment,
  stampEnvironment,
  type EnvironmentSource,
} from '../src/format/environment.js'
import { loadDocument } from '../src/format/migrate.js'
import { semanticHashOf } from '../src/compile/hash.js'
import { asGraphDefId, asLineageId, asNodeId } from '../src/ids.js'
import type { NodeSchema, PackInfo } from '../src/schema/model.js'

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const schemaOf = (type: string, extra?: Partial<NodeSchema>): NodeSchema => ({
  type,
  displayName: type,
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  items: [],
  ...extra,
})

const graph = (id: string, nodeTypes: Record<string, string>): GraphDef => ({
  id: asGraphDefId(id),
  name: id,
  nodes: Object.fromEntries(
    Object.entries(nodeTypes).map(([nid, type]) => [nid, { id: asNodeId(nid), type, values: {} }]),
  ),
  links: {},
  nets: {},
  reroutes: {},
  nextOrdinal: 100,
})

const doc = (graphs: Record<string, GraphDef>, root = 'g0'): WorkflowDocument => ({
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: asLineageId('lin1'),
  root: asGraphDefId(root),
  graphs,
  view: { graphs: {} },
})

const schemas: Record<string, NodeSchema> = {
  'core.add': schemaOf('core.add', { pack: 'core', signature: 'sig-add-1' }),
  'vhs.load': schemaOf('vhs.load', { pack: 'vhs.video', signature: 'sig-load-1' }),
  'vhs.save': schemaOf('vhs.save', { pack: 'vhs.video', signature: 'sig-save-1' }),
  unattributed: schemaOf('unattributed', { signature: 'sig-orphan-1' }),
  'v1.legacy': schemaOf('v1.legacy'), // no signature: V1/incomparable
}

const packs = new Map<string, PackInfo>([
  ['core', { displayName: 'Dinkster Core', version: '1.2.0' }],
  [
    'vhs.video',
    {
      displayName: 'Video Helper Suite',
      version: '3.1.4',
      artifactDigest: 'sha256:' + 'a'.repeat(64),
      source: 'registry',
      publisher: 'kosinkadink',
    },
  ],
])

const source: EnvironmentSource = {
  resolve: (type) => schemas[type],
  packs,
  server: { version: '0.9.0', schemaWire: 1 },
  frontendVersion: '0.1.0',
}

const warnings = (diags: readonly Diagnostic[]) => diags.filter((d) => d.severity === 'warning')
const errors = (diags: readonly Diagnostic[]) => diags.filter((d) => d.severity === 'error')
const codes = (diags: readonly Diagnostic[]) => diags.map((d) => d.code)

// ---------------------------------------------------------------------------
// Stamping
// ---------------------------------------------------------------------------

describe('stampEnvironment', () => {
  it('stamps used node types with pack + signature and used packs with full provenance', () => {
    const d = doc({ g0: graph('g0', { n0: 'core.add', n1: 'vhs.load' }) })
    const stamp = stampEnvironment(d, source)!
    expect(stamp.nodes).toEqual({
      'core.add': { pack: 'core', signature: 'sig-add-1' },
      'vhs.load': { pack: 'vhs.video', signature: 'sig-load-1' },
    })
    expect(stamp.packs).toEqual({
      core: { version: '1.2.0' },
      'vhs.video': {
        version: '3.1.4',
        artifactDigest: 'sha256:' + 'a'.repeat(64),
        source: 'registry',
        publisher: 'kosinkadink',
      },
    })
    expect(stamp.dinkster).toEqual({ version: '0.9.0', schemaWire: 1 })
    expect(stamp.frontend).toEqual({ version: '0.1.0' })
  })

  it('is used-only: types and packs not instantiated anywhere are absent', () => {
    const d = doc({ g0: graph('g0', { n0: 'core.add' }) })
    const stamp = stampEnvironment(d, source)!
    expect(Object.keys(stamp.nodes)).toEqual(['core.add'])
    expect(Object.keys(stamp.packs)).toEqual(['core']) // vhs.video unused -> absent
  })

  it('collects used types across ALL graph defs, not just the root', () => {
    const d = doc({
      g0: graph('g0', { n0: 'core.add', sub: '#g1' }),
      g1: graph('g1', { n1: 'vhs.save' }),
    })
    const stamp = stampEnvironment(d, source)!
    expect(Object.keys(stamp.nodes).sort()).toEqual(['core.add', 'vhs.save'])
  })

  it('excludes subgraph-instance synthetic types (#...) - they are not backend schemas', () => {
    const d = doc({
      g0: graph('g0', { sub: '#g1' }),
      g1: graph('g1', { n1: 'core.add' }),
    })
    const stamp = stampEnvironment(d, source)!
    expect(Object.keys(stamp.nodes)).toEqual(['core.add'])
  })

  it('a used type without a live signature is skipped (unresolvable or V1 schema)', () => {
    const d = doc({ g0: graph('g0', { n0: 'core.add', n1: 'v1.legacy', n2: 'NotInstalled' }) })
    const stamp = stampEnvironment(d, source)!
    expect(Object.keys(stamp.nodes)).toEqual(['core.add'])
  })

  it('returns undefined when NO used type carries a signature (V1 backend) - never an empty lie', () => {
    const d = doc({ g0: graph('g0', { n0: 'v1.legacy', n1: 'NotInstalled' }) })
    expect(stampEnvironment(d, source)).toBeUndefined()
    expect(stampEnvironment(doc({ g0: graph('g0', {}) }), source)).toBeUndefined()
  })

  it('a signed node without pack attribution stamps signature-only and adds no pack entry', () => {
    const d = doc({ g0: graph('g0', { n0: 'unattributed' }) })
    const stamp = stampEnvironment(d, source)!
    expect(stamp.nodes['unattributed']).toEqual({ signature: 'sig-orphan-1' })
    expect(stamp.packs).toEqual({})
  })

  it('a used pack absent from the packs table stamps as an empty (unpinned) entry', () => {
    const bare: EnvironmentSource = { resolve: source.resolve } // no packs table, no server
    const d = doc({ g0: graph('g0', { n0: 'vhs.load' }) })
    const stamp = stampEnvironment(d, bare)!
    expect(stamp.packs).toEqual({ 'vhs.video': {} })
    expect(stamp.dinkster).toBeUndefined()
    expect(stamp.frontend).toBeUndefined()
  })

  it('does not mutate the input document and never changes the semantic hash', () => {
    const d = doc({ g0: graph('g0', { n0: 'core.add' }) })
    const before = semanticHashOf(d)
    const stamp = stampEnvironment(d, source)!
    expect(d.environment).toBeUndefined()
    const stamped: WorkflowDocument = { ...d, environment: stamp }
    expect(semanticHashOf(stamped)).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

describe('sanitizeEnvironment', () => {
  const fullStamp = {
    dinkster: { version: '0.9.0', schemaWire: 1 },
    frontend: { version: '0.1.0' },
    packs: { core: { version: '1.2.0' }, dev: {} },
    nodes: { 'core.add': { pack: 'core', signature: 'sig-add-1' } },
  }

  it('absent stamp: no stamp, no diagnostics', () => {
    expect(sanitizeEnvironment(undefined)).toEqual({ diagnostics: [] })
  })

  it('a valid full stamp round-trips untouched', () => {
    const { stamp, diagnostics } = sanitizeEnvironment(structuredClone(fullStamp))
    expect(diagnostics).toEqual([])
    expect(stamp).toEqual(fullStamp)
  })

  it('a minimal nodes-only stamp is valid', () => {
    const { stamp, diagnostics } = sanitizeEnvironment({ nodes: { t: { signature: 's' } } })
    expect(diagnostics).toEqual([])
    expect(stamp).toEqual({ packs: {}, nodes: { t: { signature: 's' } } })
  })

  it('a non-object stamp is dropped whole with one warning', () => {
    for (const junk of ['stamp', 42, [], null]) {
      const { stamp, diagnostics } = sanitizeEnvironment(junk)
      expect(stamp).toBeUndefined()
      expect(codes(warnings(diagnostics))).toEqual(['env.stamp-malformed'])
      expect(errors(diagnostics)).toEqual([])
    }
  })

  it('malformed sections drop individually; valid parts survive', () => {
    const { stamp, diagnostics } = sanitizeEnvironment({
      dinkster: { version: '0.9.0' }, // schemaWire missing -> dropped
      frontend: { version: 42 }, // wrong type -> dropped
      packs: { good: { version: '1.0.0' }, bad: 'nope' }, // bad entry dropped
      nodes: { good: { signature: 's' }, bad: { pack: 'p' } }, // no signature -> dropped
    })
    expect(stamp).toEqual({ packs: { good: { version: '1.0.0' } }, nodes: { good: { signature: 's' } } })
    const warning = warnings(diagnostics)
    expect(codes(warning)).toEqual(['env.stamp-malformed'])
    for (const part of ['dinkster', 'frontend', 'packs.bad', 'nodes.bad']) {
      expect(warning[0]!.message).toContain(part)
    }
  })

  it('null provenance values are dropped (omitted-when-unknown, never null)', () => {
    const { stamp } = sanitizeEnvironment({
      packs: { p: { version: null, artifactDigest: null, source: 'registry' } },
      nodes: { t: { signature: 's', pack: null } },
    })
    expect(stamp!.packs['p']).toEqual({ source: 'registry' })
    expect(stamp!.nodes['t']).toEqual({ signature: 's' })
  })

  it('a stamp with nothing valid left is dropped entirely, not kept as an empty husk', () => {
    const { stamp, diagnostics } = sanitizeEnvironment({})
    expect(stamp).toBeUndefined()
    expect(codes(warnings(diagnostics))).toEqual(['env.stamp-malformed'])
    const allBad = sanitizeEnvironment({ nodes: { t: { pack: 'p' } } })
    expect(allBad.stamp).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// loadDocument integration: never load-bearing
// ---------------------------------------------------------------------------

describe('loadDocument with environment stamps', () => {
  const baseJson = () =>
    JSON.parse(
      JSON.stringify({
        format: 'dinkster-workflow',
        formatVersion: 1,
        lineage: 'lin1',
        root: 'g0',
        graphs: {
          g0: {
            id: 'g0',
            name: 'root',
            nodes: { n0: { id: 'n0', type: 'core.add', values: {} } },
            links: {},
            nets: {},
            reroutes: {},
            nextOrdinal: 1,
          },
        },
        view: { graphs: {} },
      }),
    ) as Record<string, unknown>

  it('a valid stamp survives loading', () => {
    const json = baseJson()
    json['environment'] = {
      dinkster: { version: '0.9.0', schemaWire: 1 },
      packs: { core: { version: '1.2.0' } },
      nodes: { 'core.add': { pack: 'core', signature: 'sig-add-1' } },
    }
    const result = loadDocument(json)
    expect(errors(result.diagnostics)).toEqual([])
    expect(result.document?.environment?.nodes['core.add']?.signature).toBe('sig-add-1')
  })

  it('a malformed stamp warns and drops but NEVER blocks loading', () => {
    const json = baseJson()
    json['environment'] = 'garbage'
    const result = loadDocument(json)
    expect(errors(result.diagnostics)).toEqual([])
    expect(result.document).toBeDefined()
    expect(result.document?.environment).toBeUndefined()
    expect(codes(warnings(result.diagnostics))).toContain('env.stamp-malformed')
  })

  it('partially malformed stamps load with the valid parts kept', () => {
    const json = baseJson()
    json['environment'] = {
      nodes: { 'core.add': { signature: 'sig-add-1' }, broken: 17 },
    }
    const result = loadDocument(json)
    expect(errors(result.diagnostics)).toEqual([])
    expect(result.document?.environment?.nodes).toEqual({ 'core.add': { signature: 'sig-add-1' } })
    expect(codes(warnings(result.diagnostics))).toContain('env.stamp-malformed')
  })

  it('a document without a stamp loads silently (absence is fully valid)', () => {
    const result = loadDocument(baseJson())
    expect(result.diagnostics).toEqual([])
    expect(result.document?.environment).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

describe('environmentDrift', () => {
  const stampOf = (
    nodes: EnvironmentStamp['nodes'],
    stampPacks: EnvironmentStamp['packs'] = {},
  ): EnvironmentStamp => ({ packs: stampPacks, nodes })

  it('identical environment: silent', () => {
    const stamp = stampOf(
      { 'core.add': { pack: 'core', signature: 'sig-add-1' } },
      { core: { version: '1.2.0' } },
    )
    expect(environmentDrift(stamp, source)).toEqual([])
  })

  it('signature mismatch names the node type precisely (env.node-drift, warning)', () => {
    const stamp = stampOf({
      'core.add': { pack: 'core', signature: 'sig-add-OLD' },
      'vhs.load': { pack: 'vhs.video', signature: 'sig-load-1' },
    })
    const out = environmentDrift(stamp, source)
    expect(codes(out)).toEqual(['env.node-drift'])
    expect(out[0]!.severity).toBe('warning')
    expect(out[0]!.message).toContain("'core.add'")
    expect(out[0]!.message).toContain("'core'")
  })

  it('a stamped type missing from the live backend surfaces env.node-missing', () => {
    const stamp = stampOf({ Gone: { pack: 'vhs.video', signature: 'x' } })
    const out = environmentDrift(stamp, source)
    expect(codes(out)).toEqual(['env.node-missing'])
    expect(out[0]!.severity).toBe('warning')
    expect(out[0]!.message).toContain("'Gone'")
  })

  it('a live schema without a signature is incomparable and stays silent (V1)', () => {
    const stamp = stampOf({ 'v1.legacy': { signature: 'whatever' } })
    expect(environmentDrift(stamp, source)).toEqual([])
  })

  it('pack pin changed but every used interface identical: info-level env.pack-updated, not alarm', () => {
    const stamp = stampOf(
      { 'vhs.load': { pack: 'vhs.video', signature: 'sig-load-1' } },
      { 'vhs.video': { version: '2.0.0', artifactDigest: 'sha256:' + 'b'.repeat(64) } },
    )
    const out = environmentDrift(stamp, source)
    expect(codes(out)).toEqual(['env.pack-updated'])
    expect(out[0]!.severity).toBe('info')
    expect(out[0]!.message).toContain('2.0.0')
    expect(out[0]!.message).toContain('3.1.4')
  })

  it('digest is the preferred pin: same version but different digest still reports pack-updated', () => {
    const stamp = stampOf(
      { 'vhs.load': { pack: 'vhs.video', signature: 'sig-load-1' } },
      { 'vhs.video': { version: '3.1.4', artifactDigest: 'sha256:' + 'c'.repeat(64) } },
    )
    expect(codes(environmentDrift(stamp, source))).toEqual(['env.pack-updated'])
  })

  it('node findings suppress the pack-updated info for the same pack (no double reporting)', () => {
    const stamp = stampOf(
      { 'vhs.load': { pack: 'vhs.video', signature: 'sig-load-OLD' } },
      { 'vhs.video': { version: '2.0.0' } },
    )
    expect(codes(environmentDrift(stamp, source))).toEqual(['env.node-drift'])
  })

  it('unpinned stamps and packs missing from the live table stay silent', () => {
    const stamp = stampOf(
      { 'core.add': { pack: 'core', signature: 'sig-add-1' } },
      { core: {}, 'gone.pack': { version: '9.9.9' } },
    )
    expect(environmentDrift(stamp, source)).toEqual([])
  })

  it('everything is advisory: severities never exceed warning', () => {
    const stamp = stampOf(
      { Gone: { signature: 'x' }, 'core.add': { signature: 'nope' } },
      { 'vhs.video': { version: '0.0.1' } },
    )
    const out = environmentDrift(stamp, source)
    expect(out.length).toBeGreaterThan(0)
    expect(errors(out)).toEqual([])
  })
})
