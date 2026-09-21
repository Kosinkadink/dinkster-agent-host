/**
 * JSON ownership boundary.
 *
 * Everything that enters the document - command params, transaction values,
 * loaded documents - passes through ownJson exactly once. It is the single
 * validator/normalizer for JSON semantics:
 *
 * - cycle-safe: a cyclic value is rejected, never recursed into
 * - depth/size budgeted: rejection instead of a RangeError somewhere deep
 *   inside canonicalJson/structuredClone/deepFreeze later (compile totality
 *   is an INGRESS guarantee, not a per-traversal one)
 * - JSON semantics only: finite numbers, plain objects/arrays, string keys,
 *   own enumerable properties; functions/symbols/bigints/class instances
 *   are rejected; object properties whose value is undefined are dropped
 *   (JSON.stringify semantics); undefined INSIDE an array is rejected
 * - the result is an OWNED deep copy, frozen at every level: callers may
 *   share it freely and structural sharing downstream is safe by
 *   construction
 *
 * Budgets are deliberately generous - real documents are nowhere near them;
 * they exist to make hostile or accidental pathology a diagnostic instead
 * of a crash.
 */

import type { Json } from './document.js'

export const MAX_JSON_DEPTH = 64
export const MAX_JSON_NODES = 4_000_000
/**
 * Total string budget in UTF-16 code units, shared by every string VALUE
 * and every object KEY in one ownJson call. Node counting alone would let
 * a single multi-gigabyte string (one node) through; this closes that hole.
 */
export const MAX_JSON_CHARS = 64_000_000

/** Hostile thrown values must not smuggle unbounded strings into diagnostics. */
const MAX_DIAGNOSTIC_CHARS = 200

export type OwnJsonResult =
  | { readonly ok: true; readonly value: Json }
  | { readonly ok: false; readonly reason: string }

export interface OwnJsonOptions {
  /**
   * What an object property whose value is undefined means. 'drop' matches
   * JSON.stringify (load/serialization paths); 'reject' preserves command
   * contracts where {key: undefined} must be an ERROR, never a silent
   * partial update (e.g. node.setValues).
   */
  readonly undefinedProps?: 'drop' | 'reject'
  /**
   * Budget overrides for TESTS ONLY (proving enforcement without allocating
   * production-budget-sized hostile inputs). Production callers use the
   * exported defaults.
   */
  readonly limits?: {
    readonly maxDepth?: number
    readonly maxNodes?: number
    readonly maxChars?: number
  }
}

/** Internal rejection sentinel - never confusable with owned JSON. */
class Fail {
  constructor(readonly reason: string) {}
}

/**
 * Best-effort ': message' suffix from a thrown value WITHOUT invoking
 * accessors or toString - descriptor-only, own data property only.
 */
function safeErrorMessage(e: unknown): string {
  if (typeof e !== 'object' || e === null) {
    return typeof e === 'string' ? `: ${e.slice(0, MAX_DIAGNOSTIC_CHARS)}` : ''
  }
  try {
    const desc = Object.getOwnPropertyDescriptor(e, 'message')
    const msg: unknown = desc && 'value' in desc ? desc.value : undefined
    return typeof msg === 'string' && msg.length > 0
      ? `: ${msg.slice(0, MAX_DIAGNOSTIC_CHARS)}`
      : ''
  } catch {
    return ''
  }
}

/**
 * Best-effort constructor name for diagnostics WITHOUT invoking accessors:
 * both `constructor` on the prototype and `name` on the function are read
 * through descriptors and used only when they are plain data properties.
 */
function safeCtorName(proto: object): string {
  const ctorDesc = Object.getOwnPropertyDescriptor(proto, 'constructor')
  const ctor: unknown = ctorDesc && 'value' in ctorDesc ? ctorDesc.value : undefined
  if (typeof ctor !== 'function') return 'exotic'
  const nameDesc = Object.getOwnPropertyDescriptor(ctor, 'name')
  const name: unknown = nameDesc && 'value' in nameDesc ? nameDesc.value : undefined
  return typeof name === 'string' && name.length > 0 ? name : 'exotic'
}

/**
 * Validate, normalize, deep-copy, and deep-freeze a value into owned JSON.
 * Never throws on bad input; the failure reason names the offending path.
 *
 * Hostile-input hardening: property reads go through descriptors (accessors
 * are rejected, never invoked), '__proto__' keys are rejected (assignment
 * would silently mutate the copy's prototype), sparse arrays are rejected
 * (reading a hole would consult Array.prototype), and any reflection trap
 * thrown by a Proxy is converted into a rejection.
 */
export function ownJson(input: unknown, options?: OwnJsonOptions): OwnJsonResult {
  const rejectUndefined = options?.undefinedProps === 'reject'
  const maxDepth = options?.limits?.maxDepth ?? MAX_JSON_DEPTH
  const maxNodes = options?.limits?.maxNodes ?? MAX_JSON_NODES
  const maxChars = options?.limits?.maxChars ?? MAX_JSON_CHARS
  // Node budget charges every VALUE and every object property SLOT
  // (including dropped-undefined props, which never reach visit); the char
  // budget charges every string value and object key by code-unit length.
  // Together they make total work proportional to the budgets, never to
  // hostile input size.
  let nodes = 0
  let chars = 0
  // Ancestor set for cycle detection: only containers on the CURRENT path.
  const ancestors = new Set<object>()

  const chargeChars = (s: string): Fail | undefined => {
    chars += s.length
    if (chars > maxChars) return new Fail(`value exceeds ${maxChars} string characters`)
    return undefined
  }

  const visit = (value: unknown, path: string, depth: number): Json | Fail => {
    nodes += 1
    if (nodes > maxNodes) return new Fail(`value exceeds ${maxNodes} JSON nodes`)
    if (value === null) return null
    switch (typeof value) {
      case 'string': {
        const over = chargeChars(value)
        return over ?? value
      }
      case 'boolean':
        return value
      case 'number':
        if (!Number.isFinite(value)) return new Fail(`${path}: non-finite number`)
        // JSON has no signed zero: -0 serializes as 0, so preserving it
        // would make owned values diverge from their own round-trip.
        return value === 0 ? 0 : value
      case 'object':
        break
      default:
        return new Fail(`${path}: ${typeof value} is not JSON`)
    }
    if (depth >= maxDepth) return new Fail(`${path}: nested deeper than ${maxDepth} levels`)
    const obj = value as object
    if (ancestors.has(obj)) return new Fail(`${path}: cyclic value`)
    ancestors.add(obj)
    try {
      if (Array.isArray(obj)) {
        // `length` on a real Array is always an own data property, but
        // Array.isArray is true for a Proxy over an array, whose traps can
        // answer anything. Read it ONCE through the descriptor, validate,
        // and pre-charge the whole span against the node budget BEFORE
        // allocating or crawling - a lying length must fail cheap.
        const lenDesc = Object.getOwnPropertyDescriptor(obj, 'length')
        const len: unknown = lenDesc && 'value' in lenDesc ? lenDesc.value : undefined
        if (typeof len !== 'number' || !Number.isSafeInteger(len) || len < 0)
          return new Fail(`${path}: array length is not a safe non-negative integer`)
        if (nodes + len > maxNodes) return new Fail(`value exceeds ${maxNodes} JSON nodes`)
        const copy: Json[] = new Array(len)
        for (let i = 0; i < len; i++) {
          // Own data elements only: a hole would read Array.prototype, an
          // accessor element would run caller code.
          const desc = Object.getOwnPropertyDescriptor(obj, i)
          if (desc === undefined) return new Fail(`${path}[${i}]: sparse array (hole)`)
          if (!('value' in desc)) return new Fail(`${path}[${i}]: accessor property is not JSON`)
          const el: unknown = desc.value
          if (el === undefined) return new Fail(`${path}[${i}]: undefined array element`)
          const owned = visit(el, `${path}[${i}]`, depth + 1)
          if (owned instanceof Fail) return owned
          copy[i] = owned
        }
        return Object.freeze(copy)
      }
      const proto: object | null = Object.getPrototypeOf(obj)
      if (proto !== Object.prototype && proto !== null) {
        // Descriptor-only name extraction: reading proto.constructor.name
        // directly could invoke a hostile accessor.
        return new Fail(`${path}: non-plain object (${safeCtorName(proto)})`)
      }
      // Object.keys must materialize the full key list (that allocation is
      // the ownKeys trap's own doing for a Proxy); bulk-check it against
      // the remaining budget before crawling descriptors key by key.
      const keys = Object.keys(obj)
      if (nodes + keys.length > maxNodes) return new Fail(`value exceeds ${maxNodes} JSON nodes`)
      const copy: Record<string, Json> = {}
      for (const key of keys) {
        const over = chargeChars(key)
        if (over) return over
        // '__proto__' as an own key is JSON-legal but unrepresentable here:
        // plain assignment on the copy would REPLACE its prototype instead
        // of creating the property. Nothing legitimate carries it - reject.
        if (key === '__proto__') return new Fail(`${path}: forbidden key '__proto__'`)
        const desc = Object.getOwnPropertyDescriptor(obj, key)
        if (desc === undefined) {
          // Deleted mid-iteration by a trap; treat as absent - but the SLOT
          // still cost enumeration work. Without this charge, a Proxy whose
          // descriptors vanish between the Object.keys pass and this read
          // could enumerate keys without ever consuming budget.
          nodes += 1
          if (nodes > maxNodes) return new Fail(`value exceeds ${maxNodes} JSON nodes`)
          continue
        }
        if (!('value' in desc)) return new Fail(`${path}.${key}: accessor property is not JSON`)
        const v: unknown = desc.value
        if (v === undefined) {
          if (rejectUndefined) return new Fail(`${path}.${key}: undefined property`)
          // JSON.stringify drops undefined props - but the SLOT still cost
          // enumeration work, so it still consumes node budget.
          nodes += 1
          if (nodes > maxNodes) return new Fail(`value exceeds ${maxNodes} JSON nodes`)
          continue
        }
        const owned = visit(v, `${path}.${key}`, depth + 1)
        if (owned instanceof Fail) return owned
        copy[key] = owned
      }
      return Object.freeze(copy)
    } finally {
      ancestors.delete(obj)
    }
  }

  // The visitor itself never throws, but hostile Proxies can throw from any
  // reflection operation (getPrototypeOf, ownKeys, descriptor traps).
  let result: Json | Fail
  try {
    result = visit(input, '$', 0)
  } catch (e) {
    // The thrown value itself is hostile input: e.message may be an
    // accessor and String(e) invokes toString/Symbol.toPrimitive. Extract
    // a message only when it is a plain own DATA property.
    result = new Fail(`reflection failed${safeErrorMessage(e)}`)
  }
  if (result instanceof Fail) return { ok: false, reason: result.reason }
  return { ok: true, value: result }
}

