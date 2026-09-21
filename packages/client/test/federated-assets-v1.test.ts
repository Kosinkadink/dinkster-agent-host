import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  AssetDtoV1Client,
  assetDtoV1Contract,
  decodeAssetResolveResponseV1,
  decodeCandidatesResponseV1,
  decodeCatalogResponseV1,
  decodeErrorResponseV1,
  encodeAssetResolveRequestV1,
  encodeCandidatesRequestV1,
  encodeCatalogRequestV1,
} from '../src/index.js'

const TEST_PATHS = { catalog: '/api/catalog', candidates: '/api/catalog/candidates' } as const

const fixture = JSON.parse(readFileSync(new URL('./fixtures/federated-assets-v1.json', import.meta.url), 'utf8')) as Record<string, any>

describe('federated asset DTO v1', () => {
  it('encodes a catalog request with an opaque cursor', () => {
    expect(encodeCatalogRequestV1({ query: 'flux', cursor: 'opaque.+/==', limit: 3 })).toEqual({ contractVersion: 1, query: 'flux', cursor: 'opaque.+/==', limit: 3 })
  })

  it('accepts every backend-derived fixture boundary', () => {
    const { contractVersion: _catalogVersion, ...catalogRequest } = fixture.catalogRequest
    const { contractVersion: _candidatesVersion, ...candidatesRequest } = fixture.candidatesRequest
    expect(encodeCatalogRequestV1(catalogRequest)).toEqual(fixture.catalogRequest)
    expect(encodeCandidatesRequestV1(candidatesRequest)).toEqual(fixture.candidatesRequest)
    expect(decodeCatalogResponseV1(fixture.catalogResponse).items).toHaveLength(2)
    expect(decodeCandidatesResponseV1(fixture.candidatesResponse).selectedCandidate?.reason).toBe('explicit-selection')
    expect(decodeAssetResolveResponseV1(fixture.resolveResponse).repair?.documentDigest).toBe('revision:7')
    expect(decodeErrorResponseV1(fixture.errors.authentication401, 401).error.code).toBe('authentication-required')
    expect(decodeErrorResponseV1(fixture.errors.forbidden403, 403).error.code).toBe('forbidden')
    expect(decodeErrorResponseV1(fixture.errors.invalidRequest400, 400).error.code).toBe('invalid-request')
    expect(decodeErrorResponseV1(fixture.errors.integrityMismatch422, 422).error.code).toBe('integrity-mismatch')
  })

  it.each([
    ['unknown request key', { query: 'x', invented: true }],
    ['out of range limit', { limit: 101 }],
    ['duplicate availability', { availability: ['local', 'local'] }],
    ['mismatched asset kind', { assetKind: 'image', context: { assetKind: 'model', schema: { nodeType: 'Load', inputId: 'x' }, accept: [] } }],
  ])('fails closed for %s', (_label, request) => {
    expect(() => encodeCatalogRequestV1(request as never)).toThrow()
  })

  it('rejects unordered candidates and mismatched HTTP status', () => {
    const reversed = { ...fixture.catalogResponse, items: [...fixture.catalogResponse.items].reverse() }
    expect(() => decodeCatalogResponseV1(reversed)).toThrow('strictly ordered')
    expect(() => decodeErrorResponseV1(fixture.errors.authentication401, 403)).toThrow('status')
  })

  it('enforces opaque cursor bounds, identifier controls, error field types, and empty document tokens', () => {
    expect(() => decodeCatalogResponseV1({ ...fixture.catalogResponse, nextCursor: 'x'.repeat(4097) })).toThrow('cursor')
    expect(() => decodeCandidatesResponseV1({ ...fixture.candidatesResponse, nextCursor: 'x'.repeat(4097) })).toThrow('cursor')
    const controlled = structuredClone(fixture.catalogResponse)
    controlled.items[0].logicalId = 'bad\u0000id'
    expect(() => decodeCatalogResponseV1(controlled)).toThrow('candidate')
    expect(() => decodeErrorResponseV1({ contractVersion: 1, error: { code: 'invalid-request', reason: 'bad', field: null } }, 400)).toThrow('field')
    const emptyToken = structuredClone(fixture.resolveResponse)
    emptyToken.repair.documentDigest = ''
    expect(decodeAssetResolveResponseV1(emptyToken).repair?.documentDigest).toBe('')
  })

  it('matches Python code-point lengths, ordering, scope whitespace, and repair target sets', () => {
    const nonBmp = String.fromCodePoint(0x1f600)
    expect(encodeCatalogRequestV1({ cursor: nonBmp.repeat(4096), scope: '\u0001scope' }).cursor).toHaveLength(8192)
    expect(() => encodeCatalogRequestV1({ cursor: nonBmp.repeat(4097) })).toThrow('cursor')
    const ordered = structuredClone(fixture.catalogResponse)
    ordered.items = [
      { ...ordered.items[0], logicalId: '\uE000' },
      { ...ordered.items[1], logicalId: '\u{10000}' },
    ]
    expect(decodeCatalogResponseV1(ordered).items).toHaveLength(2)
    const mismatchedRepair = structuredClone(fixture.resolveResponse)
    mismatchedRepair.repair.preconditions = [
      { ...mismatchedRepair.repair.preconditions[0], pointer: '/a' },
      { ...mismatchedRepair.repair.preconditions[0], pointer: '/b\n/c' },
    ]
    mismatchedRepair.repair.replacements = [
      { ...mismatchedRepair.repair.replacements[0], pointer: '/a\n/b' },
      { ...mismatchedRepair.repair.replacements[0], pointer: '/c' },
    ]
    expect(() => decodeAssetResolveResponseV1(mismatchedRepair)).toThrow('targets')
  })

  it('fails closed on nested request trust boundaries', () => {
    const context = { assetKind: 'model', schema: { nodeType: 'Load', inputId: 'model' }, accept: [] }
    expect(() => encodeCandidatesRequestV1({ context, expected: {} })).toThrow('digest or size')
    expect(() => encodeCandidatesRequestV1({ context, expected: { digest: `blake3:${'a'.repeat(64)}` }, selection: { logicalId: 'x', variantId: 'y', digest: `blake3:${'b'.repeat(64)}` } })).toThrow('equal')
    expect(() => encodeCandidatesRequestV1(Object.create({ context }))).toThrow('plain object')
    const current = fixture.resolveResponse.selected
    expect(() => encodeAssetResolveRequestV1({ mode: 'existing', context, document: { digest: 'revision:1', occurrences: [{ pointer: '/bad~2pointer', current }] } })).toThrow('pointer')
    expect(() => encodeAssetResolveRequestV1({ mode: 'existing', context, document: { digest: 'revision:1', occurrences: Array.from({ length: 257 }, () => ({ pointer: '/x', current })) } })).toThrow('occurrences')
  })

  it('rejects JSON arrays masquerading as enum strings', () => {
    const localWithoutRef = structuredClone(fixture.catalogResponse)
    delete localWithoutRef.items[0].assetRef
    localWithoutRef.items[0].availability.status = ['local']
    expect(() => decodeCatalogResponseV1(localWithoutRef)).toThrow(/invalid availability/)

    const compatibilityArray = structuredClone(fixture.catalogResponse)
    compatibilityArray.items[0].compatibility = { status: ['compatible'], reason: '' }
    expect(() => decodeCatalogResponseV1(compatibilityArray)).toThrow(/invalid compatibility/)

    const providerStatusArray = structuredClone(fixture.catalogResponse)
    providerStatusArray.items[0].providerSources[0].status = ['available']
    expect(() => decodeCatalogResponseV1(providerStatusArray)).toThrow(/invalid provider source/)

    const resolvedWithoutSelection = structuredClone(fixture.candidatesResponse)
    delete resolvedWithoutSelection.selectedCandidate
    resolvedWithoutSelection.status = ['resolved']
    expect(() => decodeCandidatesResponseV1(resolvedWithoutSelection)).toThrow(/invalid status/)

    const reasonArray = structuredClone(fixture.candidatesResponse)
    reasonArray.selectedCandidate.reason = ['explicit-selection']
    expect(() => decodeCandidatesResponseV1(reasonArray)).toThrow(/invalid selected reason/)

    const resolveStatusArray = structuredClone(fixture.resolveResponse)
    resolveStatusArray.status = ['resolved-existing']
    expect(() => decodeAssetResolveResponseV1(resolveStatusArray)).toThrow(/invalid resolve status/)

    const errorCodeArray = structuredClone(fixture.errors.authentication401)
    errorCodeArray.error.code = ['authentication-required']
    expect(() => decodeErrorResponseV1(errorCodeArray, 401)).toThrow(/invalid error code/)
  })

  it('fails closed when an allowed optional field is inherited rather than own', () => {
    const localRef = structuredClone(fixture.catalogResponse.items[0].assetRef)
    const polluted = structuredClone(fixture.catalogResponse)
    delete polluted.items[0].assetRef
    try {
      ;(Object.prototype as Record<string, unknown>)['assetRef'] = localRef
      expect(() => decodeCatalogResponseV1(polluted)).toThrow(/inherited/)
    } finally {
      delete (Object.prototype as Record<string, unknown>)['assetRef']
    }
    const cursorless = structuredClone(fixture.catalogResponse)
    delete cursorless.nextCursor
    try {
      ;(Object.prototype as Record<string, unknown>)['nextCursor'] = 'stolen'
      expect(() => decodeCatalogResponseV1(cursorless)).toThrow(/inherited/)
    } finally {
      delete (Object.prototype as Record<string, unknown>)['nextCursor']
    }
  })

  it('rejects sparse arrays before JSON serialization can turn holes into null', () => {
    const context = { assetKind: 'model', schema: { nodeType: 'Load', inputId: 'model' }, accept: Array(1) as string[] }
    expect(() => encodeCandidatesRequestV1({ context })).toThrow('context')
    expect(() => encodeCatalogRequestV1({ availability: Array(1) as ('local')[] })).toThrow('filters')
    expect(() => encodeAssetResolveRequestV1({
      mode: 'existing',
      context: { ...context, accept: [] },
      consents: { license: Array(1) as string[] },
    })).toThrow('consents')
    expect(() => decodeCatalogResponseV1({ contractVersion: 1, items: Array(1) })).toThrow()
  })

  it.each([
    [400, { code: 'invalid-request' }],
    [401, { code: 'authentication-required', reason: 'required', field: 'forbidden' }],
    [409, { code: 'selection-required', reason: 'different-digest', candidates: [] }],
    [409, { code: 'credential-required', requirementId: 'token' }],
    [422, { code: 'wrong-kind', expectedKind: 'model', reason: 'forbidden' }],
    [422, { code: 'integrity-mismatch', expectedSize: 1, observedSize: 1 }],
  ])('rejects code-specific error field violations at status %i', (status, error) => {
    expect(() => decodeErrorResponseV1({ contractVersion: 1, error }, status)).toThrow()
  })

  it('uses injected codecs and propagates abort signals', async () => {
    const encodeRequest = vi.fn(() => ({ custom: true }))
    const decodeResponse = vi.fn(() => ({ contractVersion: 1 as const, items: [] }))
    const decodeError = vi.fn()
    const controller = new AbortController()
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal)
      expect(JSON.parse(String(init?.body))).toEqual({ contractVersion: 1, custom: true })
      throw new DOMException('aborted', 'AbortError')
    })
    const contract = { ...assetDtoV1Contract(TEST_PATHS), catalog: { encodeRequest, decodeResponse }, decodeError }
    await expect(new AssetDtoV1Client('', contract, fetchFn).catalog({}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(encodeRequest).toHaveBeenCalledOnce()
    expect(decodeResponse).not.toHaveBeenCalled()
    expect(decodeError).not.toHaveBeenCalled()
  })

  it.each(['catalog', 'candidates'] as const)('rejects an injected %s codec that overrides contractVersion', (operation) => {
    const contract = assetDtoV1Contract(TEST_PATHS)
    const adversarial = {
      ...contract,
      [operation]: { ...contract[operation], encodeRequest: () => ({ contractVersion: 2 }) },
    }
    const client = new AssetDtoV1Client('', adversarial, vi.fn())
    expect(() => operation === 'catalog'
      ? client.catalog({})
      : client.candidates({ context: { assetKind: 'model', schema: { nodeType: 'Load', inputId: 'model' }, accept: [] } })).toThrow('contractVersion')
  })

  it('does not probe resolve when its injected path is absent', () => {
    const fetchFn = vi.fn()
    const client = new AssetDtoV1Client('', assetDtoV1Contract(TEST_PATHS), fetchFn)
    expect(() => client.resolve({ mode: 'existing', context: { assetKind: 'model', schema: { nodeType: 'Load', inputId: 'model' }, accept: [] } })).toThrow('resolve path is not configured')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('supports bearer injection through the fetch wrapper', async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer secret' }))
      return new Response(JSON.stringify({ contractVersion: 1, items: [] }))
    })
    const bearer = (url: string, init?: RequestInit) => fetchFn(url, { ...init, headers: { ...init?.headers, Authorization: 'Bearer secret' } })
    await new AssetDtoV1Client('', assetDtoV1Contract(TEST_PATHS), bearer).catalog({ limit: 1 })
  })
})
