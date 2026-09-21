import { describe, expect, it } from 'vitest'
import {
  COLLAB_PROTOCOL_VERSION,
  IMAGE_DOCUMENT_FORMAT_VERSION,
  IMAGE_FIXED_POINT_SCALE,
  IMAGE_OPACITY_MAX,
  SharedImageDocumentSession,
  asImageLayerId,
  asImageLineageId,
  asImageResourceId,
  connectSharedImageDocumentSession,
  type CollabClientOp,
  type CollabConnection,
  type CollabConnectionEvent,
  type CollabServerOp,
  type CollabSessionDescriptor,
  type FetchOpsOutcome,
  type ImageDocument,
  type PostOpOutcome,
  type PutSnapshotOutcome,
} from '../src/index.js'
import { applyOps } from '../src/commands/patch.js'
import type { Json } from '../src/format/document.js'

const DIGEST_A = `blake3:${'a'.repeat(64)}` as const
const DIGEST_B = `blake3:${'b'.repeat(64)}` as const

function imageDocument(): ImageDocument {
  return {
    format: 'dinkster-image',
    formatVersion: IMAGE_DOCUMENT_FORMAT_VERSION,
    lineage: asImageLineageId('shared-image'),
    canvas: {
      width: 8,
      height: 6,
      colorSpace: 'srgb',
      channelDepth: 8,
      compositing: 'premultiplied-alpha',
    },
    allocation: { nextOrdinal: 2 },
    rootLayerIds: [asImageLayerId('l1')],
    layers: {
      l1: {
        id: asImageLayerId('l1'),
        kind: 'raster',
        name: 'Pixels',
        visible: true,
        opacity: IMAGE_OPACITY_MAX,
        transform: {
          a: IMAGE_FIXED_POINT_SCALE,
          b: 0,
          c: 0,
          d: IMAGE_FIXED_POINT_SCALE,
          tx: 0,
          ty: 0,
        },
        blendMode: 'normal',
        clipping: 'none',
        maskIds: [],
        resourceId: asImageResourceId('r0'),
        sourceRect: { x: 0, y: 0, width: 8, height: 6 },
      },
    },
    masks: {},
    resources: {
      r0: {
        id: asImageResourceId('r0'),
        kind: 'raster',
        digest: DIGEST_A,
        byteSize: 192,
        mediaType: 'image/png',
        width: 8,
        height: 6,
        colorSpace: 'srgb',
        channelDepth: 8,
        alphaMode: 'straight',
      },
    },
  }
}

class FakeServer {
  readonly descriptor: CollabSessionDescriptor = {
    protocolVersion: COLLAB_PROTOCOL_VERSION,
    sessionId: 'image-session',
    scope: 'shared',
    documentId: 'shared-image',
    documentKind: 'image',
    revision: 0,
    snapshotRevision: 0,
  }
  document: ImageDocument = imageDocument()
  readonly log: CollabServerOp[] = []
  readonly connections = new Set<FakeConnection>()

  connect(): FakeConnection {
    const connection = new FakeConnection(this)
    this.connections.add(connection)
    return connection
  }

  async post(operation: CollabClientOp): Promise<PostOpOutcome> {
    if (operation.baseRevision !== this.log.length) {
      return { kind: 'stale-base', revision: this.log.length }
    }
    this.document = applyOps(this.document as unknown as Json, operation.patch) as unknown as ImageDocument
    const accepted: CollabServerOp = {
      opId: operation.opId,
      actorId: operation.actorId,
      baseRevision: operation.baseRevision,
      revision: this.log.length + 1,
      patch: operation.patch,
      timestamp: this.log.length + 1,
    }
    this.log.push(accepted)
    for (const connection of this.connections) connection.emit({ kind: 'op', op: accepted })
    return { kind: 'accepted', op: accepted }
  }
}

class FakeConnection implements CollabConnection {
  readonly sessionId = 'image-session'
  private readonly listeners = new Set<(event: CollabConnectionEvent) => void>()

  constructor(private readonly server: FakeServer) {}

  postOp(operation: CollabClientOp): Promise<PostOpOutcome> { return this.server.post(operation) }

  fetchOps(after: number): Promise<FetchOpsOutcome> {
    return Promise.resolve({ kind: 'ops', ops: this.server.log.filter((operation) => operation.revision > after) })
  }

  fetchSnapshot(): Promise<{ readonly revision: number; readonly document: unknown }> {
    return Promise.resolve({ revision: this.server.log.length, document: this.server.document })
  }

  putSnapshot(): Promise<PutSnapshotOutcome> { return Promise.resolve({ kind: 'ok' }) }
  sendPresence(): void {}

  onEvent(listener: (event: CollabConnectionEvent) => void): () => void {
    this.listeners.add(listener)
    listener({ kind: 'connected', descriptor: this.server.descriptor })
    return () => this.listeners.delete(listener)
  }

  emit(event: CollabConnectionEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }

  close(): void { this.server.connections.delete(this) }
}

async function settle(...sessions: SharedImageDocumentSession[]): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await Promise.all(sessions.map((session) => session.settle()))
    if (sessions.every((session) => session.doc.rootLayerIds.length === sessions[0]!.doc.rootLayerIds.length)) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('shared image sessions did not settle')
}

describe('SharedImageDocumentSession', () => {
  it('rebases concurrent edits in server order', async () => {
    const server = new FakeServer()
    const first = await connectSharedImageDocumentSession(server.connect(), server.descriptor, { actorId: 'alice' })
    const second = await connectSharedImageDocumentSession(server.connect(), server.descriptor, { actorId: 'bob' })

    expect(first.dispatch({
      command: 'image.layer.update',
      params: { layerId: 'l1', name: 'Foreground' },
    }).ok).toBe(true)
    expect(second.dispatch({
      command: 'image.layer.update',
      params: { layerId: 'l1', opacity: 32_768 },
    }).ok).toBe(true)
    await settle(first, second)

    expect(server.log).toHaveLength(2)
    expect(first.doc).toEqual(server.document)
    expect(second.doc).toEqual(server.document)
    expect(server.document.layers['l1']).toMatchObject({ name: 'Foreground', opacity: 32_768 })
  })

  it('allocates disjoint ids when collaborators add raster layers concurrently', async () => {
    const server = new FakeServer()
    const first = await connectSharedImageDocumentSession(server.connect(), server.descriptor, { actorId: 'alice' })
    const second = await connectSharedImageDocumentSession(server.connect(), server.descriptor, { actorId: 'bob' })
    const add = {
      command: 'image.layer.addRaster' as const,
      params: {
        parentId: null,
        index: 1,
        name: 'Added',
        resource: {
          kind: 'raster' as const,
          digest: DIGEST_B,
          byteSize: 96,
          mediaType: 'image/png' as const,
          width: 4,
          height: 6,
          colorSpace: 'srgb' as const,
          channelDepth: 8 as const,
          alphaMode: 'straight' as const,
        },
        sourceRect: { x: 0, y: 0, width: 4, height: 6 },
      },
    }

    const left = first.dispatch(add)
    const right = second.dispatch(add)
    expect(left.ok && left.created?.layerId).toBe('l1-alice')
    expect(right.ok && right.created?.layerId).toBe('l1-bob')
    await settle(first, second)

    expect(new Set(server.document.rootLayerIds)).toEqual(new Set(['l1', 'l1-alice', 'l1-bob']))
    expect(first.doc).toEqual(server.document)
    expect(second.doc).toEqual(server.document)
  })

  it('refuses a workflow descriptor before fetching shared state', async () => {
    const server = new FakeServer()
    await expect(connectSharedImageDocumentSession(server.connect(), {
      ...server.descriptor,
      documentKind: 'workflow',
    })).rejects.toThrow('not an ImageDocument')
  })

  it('backs off when a required checkpoint cannot be published', async () => {
    const server = new FakeServer()
    const connection = server.connect()
    connection.postOp = async () => ({ kind: 'snapshot-required' })
    connection.putSnapshot = async () => { throw new Error('offline') }
    let session: SharedImageDocumentSession
    session = await connectSharedImageDocumentSession(connection, server.descriptor, {
      actorId: 'alice',
      retryDelay: async () => session.close(),
    })
    expect(session.dispatch({
      command: 'image.layer.update',
      params: { layerId: 'l1', name: 'Pending' },
    }).ok).toBe(true)

    await expect(session.settle()).resolves.toBeUndefined()
    expect(session.status.get()).toBe('closed')
  })
})
