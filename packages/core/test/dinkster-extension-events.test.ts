import { describe, expect, it } from 'vitest'
import { asConnectionId } from '../src/ids.js'
import { DinksterNormalizer, type DinksterRawJson } from '../src/events/dinkster.js'
import { decodeEffectiveExtensionSnapshot } from '../src/extensions/manifest.js'

const digest = `sha256:${'a'.repeat(64)}`
const snapshot = decodeEffectiveExtensionSnapshot({
  format: 'dinkster.extension-snapshot', version: 1, frontendApi: '1.0.0', extensions: [{
    id: 'dinkster-video-preview', version: '1.0.0', packageDigest: digest, contributionIds: [],
    selectorResolutions: [], serviceProviders: [], capabilities: ['accelerator', 'artifacts'], behaviorConfiguration: [],
    events: [{ name: 'video-preview.initialized', payload: { fps: 'number', frameCount: 'integer', height: 'integer', width: 'integer' } }],
  }],
}).snapshot!

const event = (): DinksterRawJson => ({
  type: 'node_event', jobId: 'job', runId: 'run', nodeId: 'outer[2]/preview', seq: 3,
  event: 'video-preview.initialized', pack: 'dinkster-video-preview', worker: 'worker-1', executionArm: 'native',
  schemaVersion: 1, extensionSnapshotDigest: digest, data: { fps: 24, frameCount: 12, height: 128, width: 256 },
})

describe('snapshot-declared JSON node events', () => {
  it('preserves execution provenance and owns frozen typed data while tolerating new envelope fields', () => {
    const normalizer = new DinksterNormalizer(asConnectionId('a'), () => 100, undefined, (id) => id === digest ? snapshot : undefined)
    const input: DinksterRawJson = { ...event(), futureMetadata: { ignored: true } }
    const [result] = normalizer.normalize(input)
    expect(result).toEqual({
      kind: 'extensionEvent', execution: { connection: 'a', prompt: 'job' }, timestamp: 100,
      extensionSnapshotDigest: digest, pack: 'dinkster-video-preview', event: 'video-preview.initialized', schemaVersion: 1,
      seq: 3, runtimeNodeId: 'outer[2]/preview', worker: 'worker-1', executionArm: 'native',
      data: { fps: 24, frameCount: 12, height: 128, width: 256 },
    })
    expect(Object.isFrozen(result)).toBe(true)
    if (result?.kind !== 'extensionEvent') throw new Error('missing extension event')
    expect(Object.isFrozen(result.data)).toBe(true)
    expect(result.data).not.toBe(input['data'])
    expect(Object.isFrozen(snapshot.extensions[0]!.events![0]!.payload)).toBe(true)
  })

  it.each([
    { pack: 'other-pack' }, { event: 'other.event' }, { extensionSnapshotDigest: `sha256:${'b'.repeat(64)}` },
    { schemaVersion: 2 }, { seq: -1 }, { seq: 1.5 }, { data: null },
    { data: { fps: 24, frameCount: 1.5, height: 1, width: 1 } },
    { data: { fps: Infinity, frameCount: 1, height: 1, width: 1 } },
    { data: { fps: 24, frameCount: 1, height: 1 } },
    { data: { fps: 24, frameCount: 1, height: 1, width: 1, extra: 1 } },
  ])('refuses malformed or unauthorized data %j', (change) => {
    const errors: string[] = []
    const normalizer = new DinksterNormalizer(asConnectionId('a'), () => 0, (error) => errors.push(error), (id) => id === digest ? snapshot : undefined)
    expect(normalizer.normalize({ ...event(), ...change })).toEqual([])
    expect(errors).toHaveLength(1)
  })

  it('never decodes an event with another connection snapshot or an uncorrelated run', () => {
    const normalizer = new DinksterNormalizer(asConnectionId('b'), () => 0)
    expect(normalizer.normalize(event())).toEqual([])
    expect(normalizer.normalize({ ...event(), jobId: undefined, runId: 'unseen' })).toEqual([])
  })

  it('rejects custom binary frames even when their JSON header is valid', () => {
    const normalizer = new DinksterNormalizer(asConnectionId('a'), () => 0, undefined, () => snapshot)
    const header = new TextEncoder().encode(JSON.stringify(event()))
    const frame = new ArrayBuffer(4 + header.length + 1)
    new DataView(frame).setUint32(0, header.length, false)
    new Uint8Array(frame, 4, header.length).set(header)
    expect(normalizer.normalize(frame)).toEqual([])
  })
})
