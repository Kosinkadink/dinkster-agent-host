import type { AssetRef, AssetRefRepairSuggestion } from '@dinkster/core'

export const ASSET_DTO_CONTRACT_VERSION = 1 as const
export type SourceIdentityV1 = { readonly providerId: string; readonly sourceId: string }
export type CandidateSelectionV1 = { readonly logicalId: string; readonly variantId: string; readonly digest: string; readonly source?: SourceIdentityV1 }
export type AssetResolveContextV1 = { readonly assetKind: string; readonly schema: { readonly nodeType: string; readonly inputId: string; readonly typeId?: string }; readonly accept: readonly string[] }
export type ExpectedV1 = { readonly digest?: string; readonly size?: number }
export type HintsV1 = { readonly source?: string; readonly reference?: string; readonly loaderPath?: string; readonly modelType?: string; readonly displayName?: string }
export type CandidateV1 = {
  readonly logicalId: string; readonly family: string; readonly assetKind: string; readonly variantId: string
  readonly dtype: string; readonly quantization: string; readonly format: string; readonly role: string
  readonly requirements: { readonly loaders: readonly string[]; readonly runtimes: readonly string[]; readonly hardware: readonly string[] }
  readonly digest: string; readonly size?: number; readonly mediaType?: string
  readonly availability: { readonly status: 'local' | 'downloadable' | 'unavailable'; readonly reason: string }
  readonly compatibility: { readonly status: 'compatible' | 'incompatible' | 'unknown'; readonly reason: string }
  readonly assetRef?: AssetRef
  readonly providerSources: readonly { readonly source: SourceIdentityV1; readonly status: 'available' | 'unavailable'; readonly reason: string; readonly requires: { readonly credential?: string; readonly license?: string; readonly cost?: string; readonly policyOverride?: string } }[]
}
export type CatalogRequestV1 = { readonly scope?: string; readonly query?: string; readonly assetKind?: string; readonly context?: AssetResolveContextV1; readonly availability?: readonly ('local' | 'downloadable' | 'unavailable')[]; readonly compatibility?: readonly ('compatible' | 'incompatible' | 'unknown')[]; readonly cursor?: string; readonly limit?: number }
export type CatalogResponseV1 = { readonly contractVersion: 1; readonly items: readonly CandidateV1[]; readonly nextCursor?: string }
export type CandidatesRequestV1 = { readonly context: AssetResolveContextV1; readonly scope?: string; readonly expected?: ExpectedV1; readonly hints?: HintsV1; readonly selection?: CandidateSelectionV1; readonly cursor?: string; readonly limit?: number }
export type SelectedReasonV1 = 'reference-mapping' | 'explicit-selection' | 'trusted-source' | 'expected-digest' | 'compatible-only'
export type SelectedCandidateV1 = CandidateSelectionV1 & { readonly reason: SelectedReasonV1 }
export type CandidatesResponseV1 = { readonly contractVersion: 1; readonly status: 'resolved' | 'missing' | 'ambiguous' | 'incompatible'; readonly items: readonly CandidateV1[]; readonly selectedCandidate?: SelectedCandidateV1; readonly nextCursor?: string }
export type AssetResolveRequestV1 = { readonly mode: 'existing' | 'acquire-managed'; readonly context: AssetResolveContextV1; readonly scope?: string; readonly expected?: ExpectedV1; readonly hints?: HintsV1; readonly selection?: CandidateSelectionV1; readonly consents?: { readonly license?: readonly string[]; readonly cost?: readonly string[]; readonly policyOverride?: readonly string[] }; readonly document?: { readonly digest: string; readonly occurrences: readonly { readonly pointer: string; readonly current: AssetRef }[] } }
export type AssetResolveResponseV1 = { readonly contractVersion: 1; readonly status: 'resolved-existing' | 'resolved-remapped' | 'acquired'; readonly selected: AssetRef; readonly selectedCandidate: SelectedCandidateV1; readonly repair?: AssetRefRepairSuggestion }
export type ErrorCodeV1 = 'invalid-request' | 'cursor-invalid' | 'authentication-required' | 'forbidden' | 'not-found' | 'selection-required' | 'not-available' | 'incompatible' | 'credential-required' | 'license-required' | 'cost-required' | 'policy-override-required' | 'source-unavailable' | 'no-compatible-destination' | 'mapping-conflict' | 'wrong-kind' | 'integrity-mismatch' | 'acquisition-failed' | 'service-unavailable'
export type ErrorResponseV1 = { readonly contractVersion: 1; readonly error: { readonly code: ErrorCodeV1; readonly reason?: string; readonly field?: string; readonly candidates?: readonly CandidateV1[]; readonly truncated?: boolean; readonly requirementId?: string; readonly selection?: CandidateSelectionV1; readonly expectedKind?: string; readonly actualKind?: string; readonly expectedDigest?: string; readonly observedDigest?: string; readonly expectedSize?: number; readonly observedSize?: number } }

const fail = (message: string): never => {
  throw new Error(`asset DTO v1: ${message}`)
}
const obj = (value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail('must be a plain object')
  const body = value as Record<string, unknown>
  const allowed = new Set([...required, ...optional])
  if (required.some((key) => !Object.hasOwn(body, key)) || Object.keys(body).some((key) => !allowed.has(key))) fail('malformed object shape')
  if ([...allowed].some((key) => !Object.hasOwn(body, key) && key in body)) fail('inherited field is not an own property')
  return body
}
const str = (v: unknown): v is string => typeof v === 'string'
const literal = <T extends string>(v: unknown, allowed: readonly T[]): v is T => str(v) && (allowed as readonly string[]).includes(v)
const codePointLength = (value: string): number => [...value].length
const identifier = (v: unknown, maximum?: number): v is string => str(v)
  && codePointLength(v) > 0
  && (maximum === undefined || codePointLength(v) <= maximum)
  && !/[\u0000-\u001f\u007f]/.test(v)
const digest = (v: unknown): v is string => str(v) && /^blake3:[0-9a-f]{64}$/.test(v)
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const strings = (v: unknown): v is string[] => Array.isArray(v) && [...v].every(str)
const boundedString = (v: unknown, maximum: number): v is string => str(v) && codePointLength(v) <= maximum
const documentToken = (v: unknown): v is string => boundedString(v, 4096)
  && !/[\u0000-\u001f\u007f]/.test(v)
const printableId = (v: unknown): v is string => str(v)
  && codePointLength(v) > 0
  && codePointLength(v) <= 256
  && [...v].every((character) => character === ' ' || !/[\p{C}\p{Z}]/u.test(character))
const reason = (v: unknown, nonempty = false): v is string => str(v)
  && codePointLength(v) <= 256
  && !/[\u0000-\u001f\u007f]/.test(v)
  && (!nonempty || codePointLength(v) > 0)
const scope = (v: unknown): v is string => str(v)
  && codePointLength(v) > 0
  && !/[\p{White_Space}\u001c-\u001f]/u.test(v)
const compareText = (left: string, right: string): number => {
  const leftPoints = [...left].map((character) => character.codePointAt(0)!)
  const rightPoints = [...right].map((character) => character.codePointAt(0)!)
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index]! - rightPoints[index]!
  }
  return leftPoints.length - rightPoints.length
}
const compareTuple = (left: readonly string[], right: readonly string[]): number => {
  for (let index = 0; index < left.length; index += 1) {
    const order = compareText(left[index]!, right[index]!)
    if (order !== 0) return order
  }
  return 0
}
const source = (v: unknown): SourceIdentityV1 => {
  const body = obj(v, ['providerId', 'sourceId'])
  if (!identifier(body.providerId) || !identifier(body.sourceId)) fail('invalid source')
  return body as SourceIdentityV1
}
const assetRef = (v: unknown): AssetRef => { const b = obj(v, ['digest', 'name', 'size', 'mediaType', 'virtualPath']); if (!digest(b.digest) || !str(b.name) || !integer(b.size) || !str(b.mediaType) || !str(b.virtualPath)) fail('invalid asset ref'); return b as AssetRef }
const context = (v: unknown): AssetResolveContextV1 => { const b = obj(v, ['assetKind', 'schema', 'accept']); const s = obj(b.schema, ['nodeType', 'inputId'], ['typeId']); if (!identifier(b.assetKind, 512) || !identifier(s.nodeType, 512) || !identifier(s.inputId, 512) || (s.typeId !== undefined && !identifier(s.typeId, 512)) || !strings(b.accept) || b.accept.length > 32 || b.accept.some((x) => x === '*/*' || !/^[\w!#$&^.+-]+\/(?:[\w!#$&^.+-]+|\*)$/.test(x))) fail('invalid context'); return b as AssetResolveContextV1 }
const selection = (v: unknown, reason = false): CandidateSelectionV1 | SelectedCandidateV1 => { const b = obj(v, reason ? ['logicalId', 'variantId', 'digest', 'reason'] : ['logicalId', 'variantId', 'digest'], ['source']); if (!identifier(b.logicalId) || !identifier(b.variantId) || !digest(b.digest)) fail('invalid selection'); if (b.source !== undefined) source(b.source); if (reason && !literal(b.reason, ['reference-mapping','explicit-selection','trusted-source','expected-digest','compatible-only'])) fail('invalid selected reason'); return b as SelectedCandidateV1 }
const candidate = (v: unknown): CandidateV1 => {
  const b = obj(v, ['logicalId','family','assetKind','variantId','dtype','quantization','format','role','requirements','digest','availability','compatibility','providerSources'], ['size','mediaType','assetRef'])
  for (const key of ['logicalId','family','assetKind','variantId','dtype','quantization','format','role'] as const) if (!identifier(b[key])) fail('invalid candidate')
  if (!digest(b.digest) || (b.size !== undefined && !integer(b.size)) || (b.mediaType !== undefined && !str(b.mediaType))) fail('invalid candidate')
  const r = obj(b.requirements, ['loaders','runtimes','hardware']); if (!strings(r.loaders) || !strings(r.runtimes) || !strings(r.hardware)) fail('invalid requirements')
  const a = obj(b.availability, ['status','reason']); if (!literal(a.status, ['local','downloadable','unavailable']) || !reason(a.reason)) fail('invalid availability')
  const c = obj(b.compatibility, ['status','reason']); if (!literal(c.status, ['compatible','incompatible','unknown']) || !reason(c.reason, c.status !== 'compatible') || (c.status === 'compatible' && c.reason !== '')) fail('invalid compatibility')
  if (!Array.isArray(b.providerSources) || b.providerSources.length > 64) fail('invalid provider sources')
  const providerKeys: string[][] = []
  for (const raw of b.providerSources as unknown[]) { const p = obj(raw, ['source','status','reason','requires']); const identity = source(p.source); providerKeys.push([identity.providerId, identity.sourceId]); if (!literal(p.status, ['available','unavailable']) || !reason(p.reason)) fail('invalid provider source'); const q = obj(p.requires, [], ['credential','license','cost','policyOverride']); if (Object.values(q).some((x) => !printableId(x))) fail('invalid provider requirements') }
  if (providerKeys.some((key, index) => index > 0 && compareTuple(key, providerKeys[index - 1]!) <= 0)) fail('provider sources must be strictly ordered and unique')
  if (a.status === 'local') { if (b.assetRef === undefined || assetRef(b.assetRef).digest !== b.digest) fail('local candidate requires matching assetRef') } else if (b.assetRef !== undefined) fail('non-local candidate cannot have assetRef')
  return b as CandidateV1
}
const candidates = (v: unknown): CandidateV1[] => {
  if (!Array.isArray(v) || v.length > 100) fail('invalid candidates')
  const decoded = [...(v as unknown[])].map(candidate)
  const keys = decoded.map((item) => [item.logicalId, item.variantId, item.digest])
  if (keys.some((key, index) => index > 0 && compareTuple(key, keys[index - 1]!) <= 0)) fail('candidates must be strictly ordered and unique')
  return decoded
}
const pointer = (value: unknown): value is string => str(value) && /^(?:\/(?:[^~/]|~[01])*)*$/.test(value)
const decodeRepair = (value: unknown): AssetRefRepairSuggestion => {
  const body = obj(value, ['type','version','atomic','documentDigest','preconditions','replacements'])
  if (body.type !== 'asset-ref-repair' || body.version !== 1 || body.atomic !== true || !documentToken(body.documentDigest)) fail('invalid repair')
  if (!Array.isArray(body.preconditions) || !Array.isArray(body.replacements) || body.preconditions.length === 0 || body.replacements.length === 0) fail('invalid repair')
  const rawPreconditions = [...(body.preconditions as unknown[])]
  const rawReplacements = [...(body.replacements as unknown[])]
  const preconditions = rawPreconditions.map((raw) => { const row = obj(raw, ['pointer','equals']); if (!pointer(row.pointer)) fail('invalid repair pointer'); return { pointer: row.pointer as string, equals: assetRef(row.equals) } })
  const replacements = rawReplacements.map((raw) => { const row = obj(raw, ['pointer','value']); if (!pointer(row.pointer)) fail('invalid repair pointer'); return { pointer: row.pointer as string, value: assetRef(row.value) } })
  const left = preconditions.map((row) => row.pointer)
  const right = replacements.map((row) => row.pointer)
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  if (leftSet.size !== left.length || rightSet.size !== right.length || leftSet.size !== rightSet.size || [...leftSet].some((target) => !rightSet.has(target))) fail('repair targets must match and be unique')
  for (const [index, first] of left.entries()) for (const second of left.slice(index + 1)) if (first === '' || second.startsWith(`${first}/`) || second === '' || first.startsWith(`${second}/`)) fail('repair targets must not overlap')
  return { type: 'asset-ref-repair', version: 1, atomic: true, documentDigest: body.documentDigest as string, preconditions, replacements }
}
const responseBase = (v: unknown, required: string[], optional: string[] = []): Record<string, unknown> => { const b = obj(v, ['contractVersion', ...required], optional); if (b.contractVersion !== 1) fail('contract version mismatch'); return b }
const encode = <T extends object>(request: T): Readonly<Record<string, unknown>> => { const b = obj(request, [], Object.keys(request)); return { contractVersion: 1, ...b } }
const validatePageRequest = (request: CatalogRequestV1 | CandidatesRequestV1): void => {
  const body = request as CatalogRequestV1
  if (body.scope !== undefined && !scope(body.scope)) fail('invalid scope')
  if (body.cursor !== undefined && !boundedString(body.cursor, 4096)) fail('invalid cursor')
  if (body.limit !== undefined && (!integer(body.limit) || body.limit < 1 || body.limit > 100)) fail('invalid limit')
}
const expected = (value: unknown): ExpectedV1 => {
  const body = obj(value, [], ['digest', 'size'])
  if (body.digest === undefined && body.size === undefined) fail('expected must contain digest or size')
  if (body.digest !== undefined && !digest(body.digest)) fail('invalid expected digest')
  if (body.size !== undefined && !integer(body.size)) fail('invalid expected size')
  return body as ExpectedV1
}
const hints = (value: unknown): HintsV1 => {
  const body = obj(value, [], ['source', 'reference', 'loaderPath', 'modelType', 'displayName'])
  if (Object.values(body).some((item) => !boundedString(item, 1024))) fail('invalid hints')
  return body as HintsV1
}
const validateResolutionInputs = (request: CandidatesRequestV1 | AssetResolveRequestV1): void => {
  const checkedExpected = request.expected === undefined ? undefined : expected(request.expected)
  if (request.hints !== undefined) hints(request.hints)
  const checkedSelection = request.selection === undefined ? undefined : selection(request.selection)
  if (checkedExpected?.digest !== undefined && checkedSelection !== undefined && checkedExpected.digest !== checkedSelection.digest) fail('expected digest must equal selection digest')
}
export const encodeCatalogRequestV1 = (request: CatalogRequestV1) => {
  obj(request, [], ['scope','query','assetKind','context','availability','compatibility','cursor','limit'])
  validatePageRequest(request)
  if (request.query !== undefined && !boundedString(request.query, 512)) fail('invalid query')
  if (request.assetKind !== undefined && !identifier(request.assetKind, 512)) fail('invalid asset kind')
  if (request.context !== undefined) context(request.context)
  if (request.assetKind && request.context && request.assetKind !== request.context.assetKind) fail('asset kinds must agree')
  for (const [values, allowed] of [[request.availability, ['local','downloadable','unavailable']], [request.compatibility, ['compatible','incompatible','unknown']]] as const) {
    if (values !== undefined) {
      if (!Array.isArray(values)) fail('invalid filters')
      const materialized = [...values]
      if (new Set(materialized).size !== materialized.length || materialized.some((value) => !(allowed as readonly string[]).includes(value))) fail('invalid filters')
    }
  }
  return encode(request)
}
export const encodeCandidatesRequestV1 = (request: CandidatesRequestV1) => {
  obj(request, ['context'], ['scope','expected','hints','selection','cursor','limit'])
  context(request.context)
  validatePageRequest(request)
  validateResolutionInputs(request)
  return encode(request)
}
export const encodeAssetResolveRequestV1 = (request: AssetResolveRequestV1) => {
  obj(request, ['mode','context'], ['scope','expected','hints','selection','consents','document'])
  if (!['existing', 'acquire-managed'].includes(request.mode)) fail('invalid resolve mode')
  context(request.context)
  if (request.scope !== undefined && !scope(request.scope)) fail('invalid scope')
  validateResolutionInputs(request)
  if (request.consents !== undefined) {
    const consents = obj(request.consents, [], ['license','cost','policyOverride'])
    let total = 0
    for (const value of Object.values(consents)) {
      if (!Array.isArray(value)) fail('invalid consents')
      const ids = [...(value as unknown[])]
      if (ids.length > 16 || ids.some((item) => !printableId(item))) fail('invalid consents')
      total += ids.length
    }
    if (total > 32) fail('invalid consents')
  }
  if (request.document !== undefined) {
    const document = obj(request.document, ['digest','occurrences'])
    if (!documentToken(document.digest)) fail('invalid document digest')
    if (!Array.isArray(document.occurrences)) fail('invalid document occurrences')
    const occurrences = document.occurrences as unknown[]
    if (occurrences.length > 256) fail('invalid document occurrences')
    for (const occurrence of occurrences) { const row = obj(occurrence, ['pointer','current']); if (!pointer(row.pointer)) fail('invalid document pointer'); assetRef(row.current) }
  }
  return encode(request)
}
export const decodeCatalogResponseV1 = (v: unknown): CatalogResponseV1 => { const b = responseBase(v, ['items'], ['nextCursor']); candidates(b.items); if (b.nextCursor !== undefined && !boundedString(b.nextCursor, 4096)) fail('invalid cursor'); return b as CatalogResponseV1 }
export const decodeCandidatesResponseV1 = (v: unknown): CandidatesResponseV1 => { const b = responseBase(v, ['status','items'], ['selectedCandidate','nextCursor']); const items = candidates(b.items); if (!literal(b.status, ['resolved','missing','ambiguous','incompatible'])) fail('invalid status'); if (b.nextCursor !== undefined && !boundedString(b.nextCursor, 4096)) fail('invalid cursor'); const selected = b.selectedCandidate === undefined ? undefined : selection(b.selectedCandidate, true); if (b.status === 'resolved' && !selected) fail('resolved requires selection'); if (b.status === 'ambiguous' && selected) fail('ambiguous forbids selection'); if (selected && b.status === 'resolved') { const match = items.find((item) => item.logicalId === selected.logicalId && item.variantId === selected.variantId && item.digest === selected.digest); if (match && (match.availability.status !== 'local' || match.compatibility.status !== 'compatible')) fail('resolved selection must be local and compatible') } return b as CandidatesResponseV1 }
export const decodeAssetResolveResponseV1 = (v: unknown): AssetResolveResponseV1 => { const b = responseBase(v, ['status','selected','selectedCandidate'], ['repair']); if (!literal(b.status, ['resolved-existing','resolved-remapped','acquired'])) fail('invalid resolve status'); const ref = assetRef(b.selected); const selected = selection(b.selectedCandidate, true); if (ref.digest !== selected.digest) fail('selected digests must agree'); if (b.repair !== undefined) decodeRepair(b.repair); return b as AssetResolveResponseV1 }
const ERROR_CODES: readonly ErrorCodeV1[] = ['invalid-request','cursor-invalid','authentication-required','forbidden','not-found','selection-required','not-available','incompatible','credential-required','license-required','cost-required','policy-override-required','source-unavailable','no-compatible-destination','mapping-conflict','wrong-kind','integrity-mismatch','acquisition-failed','service-unavailable']
const ERROR_STATUS: Readonly<Record<ErrorCodeV1, number>> = { 'invalid-request':400, 'cursor-invalid':400, 'authentication-required':401, forbidden:403, 'not-found':404, 'selection-required':409, 'not-available':409, incompatible:409, 'credential-required':409, 'license-required':409, 'cost-required':409, 'policy-override-required':409, 'source-unavailable':409, 'no-compatible-destination':409, 'mapping-conflict':409, 'wrong-kind':422, 'integrity-mismatch':422, 'acquisition-failed':502, 'service-unavailable':503 }
export const decodeErrorResponseV1 = (v: unknown, status: number): ErrorResponseV1 => {
  const b = responseBase(v, ['error'])
  const e = obj(b.error, ['code'], ['reason','field','candidates','truncated','requirementId','selection','expectedKind','actualKind','expectedDigest','observedDigest','expectedSize','observedSize'])
  if (!literal(e.code, ERROR_CODES)) fail('invalid error code')
  const code = e.code as ErrorCodeV1
  if (ERROR_STATUS[code] !== status) fail('error status does not match code')
  const present = new Set(Object.keys(e).filter((key) => key !== 'code'))
  const fields: Record<ErrorCodeV1, [string[], string[]]> = {
    'invalid-request': [['reason'], ['field']], 'cursor-invalid': [['reason'], []], 'authentication-required': [['reason'], []], forbidden: [['reason'], []], 'not-found': [['reason'], []],
    'selection-required': [['reason','candidates','truncated'], []], 'not-available': [['reason','candidates','truncated'], []], incompatible: [['reason','candidates','truncated'], []],
    'credential-required': [['requirementId','selection'], []], 'license-required': [['requirementId','selection'], []], 'cost-required': [['requirementId','selection'], []], 'policy-override-required': [['requirementId','selection'], []],
    'source-unavailable': [['reason'], ['selection']], 'no-compatible-destination': [['reason'], ['selection']], 'mapping-conflict': [['reason'], ['selection']], 'acquisition-failed': [['reason'], ['selection']], 'service-unavailable': [['reason'], ['selection']],
    'wrong-kind': [['expectedKind'], ['actualKind']], 'integrity-mismatch': [[], ['expectedDigest','observedDigest','expectedSize','observedSize']],
  }
  const [required, optional] = fields[code]
  if (required.some((key) => !present.has(key)) || [...present].some((key) => !required.includes(key) && !optional.includes(key))) fail('error fields do not match code')
  if (e.reason !== undefined && !reason(e.reason)) fail('invalid error reason')
  if (e.field !== undefined && !str(e.field)) fail('invalid error field')
  if (code === 'cursor-invalid' && !literal(e.reason, ['malformed','query-mismatch','stale-snapshot','expired'])) fail('invalid cursor reason')
  if (code === 'selection-required' && !literal(e.reason, ['digestless','different-digest','multiple-variants','ambiguous-alias'])) fail('invalid selection reason')
  if (e.candidates !== undefined) candidates(e.candidates)
  if (e.truncated !== undefined && typeof e.truncated !== 'boolean') fail('invalid truncated flag')
  if (e.requirementId !== undefined && !printableId(e.requirementId)) fail('invalid requirement id')
  if (e.selection !== undefined) selection(e.selection)
  for (const key of ['expectedKind','actualKind'] as const) if (e[key] !== undefined && !identifier(e[key])) fail('invalid kind')
  for (const key of ['expectedDigest','observedDigest'] as const) if (e[key] !== undefined && !digest(e[key])) fail('invalid integrity digest')
  for (const key of ['expectedSize','observedSize'] as const) if (e[key] !== undefined && !integer(e[key])) fail('invalid integrity size')
  if (code === 'integrity-mismatch') {
    const digestPair = e.expectedDigest !== undefined && e.observedDigest !== undefined
    const sizePair = e.expectedSize !== undefined && e.observedSize !== undefined
    if ((!digestPair && !sizePair) || (digestPair && e.expectedDigest === e.observedDigest) || (sizePair && e.expectedSize === e.observedSize)) fail('invalid integrity mismatch')
  }
  return b as ErrorResponseV1
}
export interface AssetDtoV1OperationCodec<Q, S> { readonly encodeRequest: (request: Q) => Readonly<Record<string, unknown>>; readonly decodeResponse: (response: unknown) => S }
export interface AssetDtoV1WireContract { readonly paths: { readonly catalog: string; readonly candidates: string; readonly resolve?: string }; readonly catalog: AssetDtoV1OperationCodec<CatalogRequestV1, CatalogResponseV1>; readonly candidates: AssetDtoV1OperationCodec<CandidatesRequestV1, CandidatesResponseV1>; readonly decodeError: (response: unknown, status: number) => ErrorResponseV1 }
export const assetDtoV1Contract = (paths: AssetDtoV1WireContract['paths']): AssetDtoV1WireContract => {
  for (const path of [paths.catalog, paths.candidates, paths.resolve]) {
    if (path !== undefined && (!path.startsWith('/') || path.startsWith('//') || path.includes('?') || path.includes('#'))) fail('paths must be fixed absolute paths')
  }
  if (paths.catalog === paths.candidates) fail('catalog and candidates paths must differ')
  return { paths, catalog: { encodeRequest: encodeCatalogRequestV1, decodeResponse: decodeCatalogResponseV1 }, candidates: { encodeRequest: encodeCandidatesRequestV1, decodeResponse: decodeCandidatesResponseV1 }, decodeError: decodeErrorResponseV1 }
}
export class AssetDtoV1HttpError extends Error {
  constructor(readonly status: number, readonly error: ErrorResponseV1) {
    if (ERROR_STATUS[error.error.code] !== status) fail('error status does not match code')
    super(`asset DTO v1 request failed: ${status}`)
    this.name = 'AssetDtoV1HttpError'
  }
}
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>
const stampRequest = (body: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  if (Object.hasOwn(body, 'contractVersion') && body['contractVersion'] !== 1) fail('operation codec returned invalid contractVersion')
  return { ...body, contractVersion: 1 }
}
export class AssetDtoV1Client {
  constructor(
    private readonly baseUrl: string,
    private readonly contract: AssetDtoV1WireContract,
    private readonly fetchFn: FetchLike = (url, init) => fetch(url, init),
  ) {}
  private async post<T>(path: string, body: Record<string, unknown>, decode: (v: unknown) => T, signal?: AbortSignal): Promise<T> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    })
    const payload: unknown = await response.json()
    if (!response.ok) {
      const error = this.contract.decodeError(payload, response.status)
      throw new AssetDtoV1HttpError(response.status, error)
    }
    return decode(payload)
  }
  catalog(request: CatalogRequestV1, signal?: AbortSignal) { return this.post(this.contract.paths.catalog, stampRequest(this.contract.catalog.encodeRequest(request)), this.contract.catalog.decodeResponse, signal) }
  candidates(request: CandidatesRequestV1, signal?: AbortSignal) { return this.post(this.contract.paths.candidates, stampRequest(this.contract.candidates.encodeRequest(request)), this.contract.candidates.decodeResponse, signal) }
  resolve(request: AssetResolveRequestV1, signal?: AbortSignal) { if (!this.contract.paths.resolve) throw new Error('asset DTO v1 resolve path is not configured'); return this.post(this.contract.paths.resolve, encodeAssetResolveRequestV1(request), decodeAssetResolveResponseV1, signal) }
}
