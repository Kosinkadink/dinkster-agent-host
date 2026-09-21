/**
 * Pack provenance + explicit outputNode hint (backend commit 1aa3231,
 * additive to schema wire v3): the /api/nodes payload carries a top-level
 * "packs" presentation table and host-attached per-node "pack" attribution.
 * Both are presentation/attribution only - tolerant decode, never identity,
 * and a malformed declaration never fails schema fetch.
 */
import { describe, expect, it } from 'vitest'
import {
  DINKSTER_SCHEMA_WIRE_VERSION,
  graphFeaturesFromDinksterWire,
  mergeableTypesFromDinksterWire,
  packsFromDinksterWire,
  parseDinksterNodes,
  serverInfoFromDinksterWire,
} from '../src/index.js'

const payload = {
  schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION,
  dinkster: { version: '0.9.0', schemaWire: 3 },
  packs: {
    core: { displayName: 'Dinkster Core' },
    'vhs.video': { displayName: 'Video Helper Suite', abbr: 'VHS', mark: '\u{1F3A5}', color: '#64b5f6' },
    pinned: {
      displayName: 'Pinned Pack',
      version: '3.1.4',
      artifactDigest: 'sha256:' + 'a'.repeat(64),
      source: 'registry',
      publisher: 'kosinkadink',
    },
    'dev.pack': { displayName: 'Dev Pack', source: 'local:/home/dev/pack' },
    'junk.prov': { displayName: 'Junk Prov', version: '', artifactDigest: 42, source: null },
    bare: {},
    dropped: { displayName: 'Bad Fields', abbr: '', mark: 42, color: 'not-a-color' },
    'with.icon': {
      displayName: 'Iconed',
      icon: { digest: 'sha256:abc123', mediaType: 'image/png' },
    },
    'with.assets': {
      displayName: 'Asset Pack',
      assets: [{
        id: 'depth-anything',
        name: 'Depth Anything',
        digest: 'future-digest:abc123',
        kind: 'model/auxiliary',
        size: 1572864,
        mediaType: 'application/octet-stream',
        metadata: { family: 'depth' },
        sources: [
          { type: 'packaged', pack: 'with.assets', path: 'models/depth.bin', extra: true },
          { type: 'remote', url: 'https://example.test/depth.bin' },
        ],
        nodes: ['depth.load'],
        unknownFutureField: true,
      }],
      unknownPackField: true,
    },
    'half.icon': { displayName: 'Half', icon: { digest: 'sha256:def' } },
    'junk.icon': { displayName: 'Junk', icon: 'badge.png' },
    'with.blueprints': {
      displayName: 'Blueprinted',
      blueprints: [
        {
          id: 'txt2img',
          name: 'Text to Image',
          description: 'Prompt in, image out',
          tags: ['starter', 'image'],
          digest: 'sha256:' + 'b'.repeat(64),
          boundaryInputs: ['core.text'],
          boundaryOutputs: ['core.image'],
        },
        { id: 'bare', name: 'Bare Minimum', digest: 'sha256:' + 'c'.repeat(64) },
      ],
    },
    'junk.blueprints': {
      displayName: 'Junk Blueprints',
      blueprints: [
        { id: 'no-digest', name: 'No Digest' },
        'not-an-object',
        {
          id: 'messy',
          name: 'Messy',
          digest: 'sha256:' + 'd'.repeat(64),
          tags: [42, '', 'kept'],
          boundaryInputs: 'core.image',
          boundaryOutputs: [null, ''],
        },
      ],
    },
    'empty.blueprints': { displayName: 'Empty', blueprints: [] },
  },
  nodes: {
    'core.add': { displayName: 'Add', pack: 'core', signature: 'sig-add-1', interface: [] },
    'vhs.load': { displayName: 'Load Video', pack: 'vhs.video', interface: [] },
    orphan: { displayName: 'Orphan', interface: [] },
    'bad.sig': { displayName: 'Bad Sig', signature: 42, interface: [] },
    sink: { displayName: 'Sink', idempotent: true, outputNode: true, interface: [] },
    effectful: { displayName: 'Effectful', idempotent: false, interface: [] },
    aliased: { displayName: 'Aliased', aliases: ['LegacyName'], interface: [] },
  },
}

const { schemas, diagnostics } = parseDinksterNodes(payload)

describe('pack attribution on node schemas', () => {
  it('decodes with no diagnostics (all new fields are additive)', () => {
    expect(diagnostics).toEqual([])
    expect(schemas.size).toBe(7)
  })

  it('every attributed node carries its pack id, core included', () => {
    expect(schemas.get('core.add')?.pack).toBe('core')
    expect(schemas.get('vhs.load')?.pack).toBe('vhs.video')
  })

  it('a node without attribution has no pack (older backends)', () => {
    expect(schemas.get('orphan')?.pack).toBeUndefined()
  })

  it('aliases decode onto the schema (legacy-name resolution + migration input)', () => {
    expect(schemas.get('aliased')?.aliases).toEqual(['LegacyName'])
    // Absent or empty wire aliases leave the field off entirely.
    expect('aliases' in schemas.get('orphan')!).toBe(false)
  })
})

describe('explicit outputNode hint', () => {
  it('outputNode: true wins over the !idempotent heuristic', () => {
    expect(schemas.get('sink')?.isOutputNode).toBe(true)
  })

  it('without the hint, !idempotent stays the fallback', () => {
    expect(schemas.get('effectful')?.isOutputNode).toBe(true)
    expect(schemas.get('aliased')?.isOutputNode).toBe(false) // idempotent defaults true
  })
})

describe('packsFromDinksterWire', () => {
  const packs = packsFromDinksterWire(payload)

  it('decodes declared presentation fields', () => {
    expect(packs.get('vhs.video')).toEqual({
      displayName: 'Video Helper Suite',
      abbr: 'VHS',
      mark: '\u{1F3A5}',
      color: '#64b5f6',
    })
    expect(packs.get('core')).toEqual({ displayName: 'Dinkster Core' })
  })

  it('displayName falls back to the pack id; omission means not declared', () => {
    expect(packs.get('bare')).toEqual({ displayName: 'bare' })
  })

  it('malformed fields drop without dropping the entry (never fail fetch)', () => {
    expect(packs.get('dropped')).toEqual({ displayName: 'Bad Fields' })
  })

  it('decodes the icon descriptor (backend 2078063): digest + mediaType', () => {
    expect(packs.get('with.icon')).toEqual({
      displayName: 'Iconed',
      icon: { digest: 'sha256:abc123', mediaType: 'image/png' },
    })
  })

  it('half-formed or junk icon descriptors drop whole (no bogus-digest fetches)', () => {
    expect(packs.get('half.icon')).toEqual({ displayName: 'Half' })
    expect(packs.get('junk.icon')).toEqual({ displayName: 'Junk' })
  })

  it('decodes asset descriptors and tolerates unknown fields and digest prefixes', () => {
    expect(packs.get('with.assets')?.assets).toEqual([{
      id: 'depth-anything',
      name: 'Depth Anything',
      digest: 'future-digest:abc123',
      kind: 'model/auxiliary',
      size: 1572864,
      mediaType: 'application/octet-stream',
      metadata: { family: 'depth' },
      sources: [
        { type: 'packaged', pack: 'with.assets', path: 'models/depth.bin' },
        { type: 'remote', url: 'https://example.test/depth.bin' },
      ],
      nodes: ['depth.load'],
    }])
    expect(packs.get('core')?.assets).toBeUndefined()
  })

  it('decodes blueprint descriptors (backend ed5fdf6 + a27f52c) inline, bodies never fetched', () => {
    expect(packs.get('with.blueprints')?.blueprints).toEqual([
      {
        id: 'txt2img',
        name: 'Text to Image',
        description: 'Prompt in, image out',
        tags: ['starter', 'image'],
        digest: 'sha256:' + 'b'.repeat(64),
        boundaryInputs: ['core.text'],
        boundaryOutputs: ['core.image'],
      },
      { id: 'bare', name: 'Bare Minimum', digest: 'sha256:' + 'c'.repeat(64) },
    ])
  })

  it('blueprint descriptors without id/name/digest drop alone; junk optional members drop', () => {
    // Descriptor missing a digest can never key a body fetch: dropped.
    // Non-object entries: dropped. Siblings survive with junk members
    // filtered (non-string tags, string-typed boundary field, empty ids).
    expect(packs.get('junk.blueprints')?.blueprints).toEqual([
      { id: 'messy', name: 'Messy', digest: 'sha256:' + 'd'.repeat(64), tags: ['kept'] },
    ])
  })

  it('an empty blueprints array means absent, not empty (omission convention)', () => {
    expect(packs.get('empty.blueprints')).toEqual({ displayName: 'Empty' })
  })

  it('a payload without a packs table yields an empty map', () => {
    expect(packsFromDinksterWire({ schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION, nodes: {} }).size).toBe(0)
    expect(packsFromDinksterWire({ schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION, nodes: {}, packs: [1] }).size).toBe(0)
  })

  it('decodes provenance fields (backend 5b58c53): version/artifactDigest/source/publisher', () => {
    expect(packs.get('pinned')).toEqual({
      displayName: 'Pinned Pack',
      version: '3.1.4',
      artifactDigest: 'sha256:' + 'a'.repeat(64),
      source: 'registry',
      publisher: 'kosinkadink',
    })
  })

  it('provenance is omitted-when-unknown: a dev pack carries only its source', () => {
    expect(packs.get('dev.pack')).toEqual({ displayName: 'Dev Pack', source: 'local:/home/dev/pack' })
  })

  it('malformed provenance fields drop individually without dropping the entry', () => {
    expect(packs.get('junk.prov')).toEqual({ displayName: 'Junk Prov' })
  })
})

describe('per-node interface signature (backend 5b58c53)', () => {
  it('a string signature decodes onto the schema', () => {
    expect(schemas.get('core.add')?.signature).toBe('sig-add-1')
  })

  it('absent or malformed signatures leave the schema signature-free (older backends)', () => {
    expect(schemas.get('vhs.load')?.signature).toBeUndefined()
    expect(schemas.get('bad.sig')?.signature).toBeUndefined()
  })
})

describe('serverInfoFromDinksterWire', () => {
  it('decodes the dinkster server-identity header', () => {
    expect(serverInfoFromDinksterWire(payload)).toEqual({ version: '0.9.0', schemaWire: 3 })
  })

  it('absent or malformed headers yield undefined, never a diagnostic', () => {
    expect(serverInfoFromDinksterWire({ schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION, nodes: {} })).toBeUndefined()
    for (const dinkster of ['0.9.0', [], { version: '' }, { version: '0.9.0' }, { version: 1, schemaWire: 3 }]) {
      expect(serverInfoFromDinksterWire({ schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION, nodes: {}, dinkster })).toBeUndefined()
    }
  })
})

describe('graphFeaturesFromDinksterWire', () => {
  it('decodes graphFeatures from the dinkster header (Dinkster ea6eca7)', () => {
    const dinkster = { version: '0.9.0', schemaWire: 10, graphFeatures: ['typedLiteral'] }
    expect(graphFeaturesFromDinksterWire({ nodes: {}, dinkster })).toEqual(['typedLiteral'])
  })

  it('absent field yields undefined (older backend = no negotiated forms)', () => {
    expect(graphFeaturesFromDinksterWire({ nodes: {} })).toBeUndefined()
    expect(graphFeaturesFromDinksterWire({ nodes: {}, dinkster: { version: '0.9.0', schemaWire: 10 } })).toBeUndefined()
  })

  it('malformed field yields undefined; non-string entries drop, unknown flags pass through', () => {
    for (const graphFeatures of ['typedLiteral', {}, 7, null]) {
      expect(graphFeaturesFromDinksterWire({ nodes: {}, dinkster: { graphFeatures } })).toBeUndefined()
    }
    expect(graphFeaturesFromDinksterWire({ nodes: {}, dinkster: { graphFeatures: [7, 'typedLiteral', null, 'futureFlag'] } }))
      .toEqual(['typedLiteral', 'futureFlag'])
  })
})

describe('mergeableTypesFromDinksterWire', () => {
  it('decodes mergeableTypes from the dinkster header (Dinkster 6dbbddd)', () => {
    const dinkster = { version: '0.9.0', schemaWire: 12, mergeableTypes: ['comfy.IMAGE'] }
    expect(mergeableTypesFromDinksterWire({ nodes: {}, dinkster })).toEqual(['comfy.IMAGE'])
  })

  it('an empty list decodes as [] (settled: no providers), distinct from absent', () => {
    expect(mergeableTypesFromDinksterWire({ nodes: {}, dinkster: { version: '0.9.0', schemaWire: 12, mergeableTypes: [] } }))
      .toEqual([])
  })

  it('absent field yields undefined (older backend = merge arm off)', () => {
    expect(mergeableTypesFromDinksterWire({ nodes: {} })).toBeUndefined()
    expect(mergeableTypesFromDinksterWire({ nodes: {}, dinkster: { version: '0.9.0', schemaWire: 12 } })).toBeUndefined()
  })

  it('malformed field yields undefined; non-string entries drop silently', () => {
    for (const mergeableTypes of ['comfy.IMAGE', {}, 7, null]) {
      expect(mergeableTypesFromDinksterWire({ nodes: {}, dinkster: { mergeableTypes } })).toBeUndefined()
    }
    expect(mergeableTypesFromDinksterWire({ nodes: {}, dinkster: { mergeableTypes: [7, 'comfy.IMAGE', null, 'comfy.LATENT'] } }))
      .toEqual(['comfy.IMAGE', 'comfy.LATENT'])
  })
})
