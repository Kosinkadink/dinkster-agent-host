/**
 * Serializable document patches.
 *
 * Every document mutation is expressed as a list of PatchOps: plain-data,
 * JSON-serializable, and self-inverting (each op carries what it needs for
 * its inverse). This is the shape that lets patches cross IPC boundaries
 * (multi-window) and a server-ordered sync log (multi-user) unchanged
 * (architecture sections 17/20).
 *
 * - `add`/`remove`/`replace` mirror RFC 6902 semantics, except `remove` and
 *   `replace` carry the old value so inversion is a pure function of the op.
 * - Paths address into the document JSON tree: string segments for object
 *   keys, number segments for array indices.
 * - Application is immutable with structural sharing: untouched subtrees keep
 *   reference identity, so derived-state layers can diff by identity.
 */

import type { Json, JsonObject } from '../format/document.js'
import { ownJson } from '../format/json.js'

/** Path into the document tree. Strings = object keys, numbers = array indices. */
export type DocPath = readonly (string | number)[]

export type PatchOp =
  | { readonly op: 'add'; readonly path: DocPath; readonly value: Json }
  | { readonly op: 'remove'; readonly path: DocPath; readonly oldValue: Json }
  | {
      readonly op: 'replace'
      readonly path: DocPath
      readonly value: Json
      readonly oldValue: Json
    }

/**
 * Thrown when an op does not fit the document it is applied to, or when a
 * foreign op fails ingress. `patchOp` is undefined for ingress failures:
 * the rejected foreign object is NEVER stored or formatted (a getter,
 * Proxy trap, or hostile toString must not run inside error construction),
 * so the message carries only the op index and a safe reason.
 */
export class PatchError extends Error {
  constructor(
    readonly patchOp: PatchOp | undefined,
    reason: string,
  ) {
    super(
      patchOp === undefined
        ? `foreign patch rejected: ${reason}`
        : `patch ${patchOp.op} at ${formatPath(patchOp.path)}: ${reason}`,
    )
    this.name = 'PatchError'
  }
}

export function formatPath(path: DocPath): string {
  return '$' + path.map((s) => (typeof s === 'number' ? `[${s}]` : `.${String(s)}`)).join('')
}

function isObject(v: Json | undefined): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Read the value at `path`, or undefined if the path does not resolve. */
export function getAtPath(root: Json, path: DocPath): Json | undefined {
  let cur: Json | undefined = root
  for (const seg of path) {
    if (typeof seg === 'number') {
      // Own elements only: a hole must never read Array.prototype.
      if (!Array.isArray(cur) || !isIndex(seg) || !Object.hasOwn(cur, seg)) return undefined
      cur = cur[seg]
    } else {
      // Own properties only: 'constructor' etc. must never read the prototype.
      if (!isObject(cur) || !Object.hasOwn(cur, seg)) return undefined
      cur = cur[seg]
    }
  }
  return cur
}

/** Array segments must be safe non-negative integers - NaN/fractions never address anything. */
const isIndex = (seg: number): boolean => Number.isSafeInteger(seg) && seg >= 0

/**
 * Apply one op immutably. Containers along the path are shallow-copied;
 * everything else keeps reference identity.
 */
function applyOp(root: Json, op: PatchOp): Json {
  return applyAt(root, op.path, op)
}

function applyAt(node: Json, path: DocPath, op: PatchOp): Json {
  if (path.length === 0) {
    // Op targets this node itself (only 'replace' makes sense at the root).
    if (op.op !== 'replace') throw new PatchError(op, `${op.op} cannot target the root`)
    return op.value
  }
  const [seg, ...rest] = path as [string | number, ...(string | number)[]]

  if (typeof seg === 'number') {
    if (!Array.isArray(node)) throw new PatchError(op, `expected an array at segment ${seg}`)
    if (!isIndex(seg)) throw new PatchError(op, `index ${seg} is not a safe non-negative integer`)
    if (rest.length > 0) {
      // Own elements only: a hole must never traverse into Array.prototype.
      if (!Object.hasOwn(node, seg)) throw new PatchError(op, `index ${seg} out of bounds`)
      const child = node[seg]
      if (child === undefined) throw new PatchError(op, `index ${seg} out of bounds`)
      const next = applyAt(child, rest, op)
      const copy = node.slice()
      copy[seg] = next
      return Object.freeze(copy)
    }
    switch (op.op) {
      case 'add': {
        if (seg > node.length) throw new PatchError(op, `insert index ${seg} out of bounds`)
        return Object.freeze([...node.slice(0, seg), op.value, ...node.slice(seg)])
      }
      case 'remove': {
        if (seg >= node.length) throw new PatchError(op, `remove index ${seg} out of bounds`)
        return Object.freeze([...node.slice(0, seg), ...node.slice(seg + 1)])
      }
      case 'replace': {
        if (seg >= node.length) throw new PatchError(op, `replace index ${seg} out of bounds`)
        const copy = node.slice()
        copy[seg] = op.value
        return Object.freeze(copy)
      }
    }
  }

  if (!isObject(node)) throw new PatchError(op, `expected an object at segment '${seg}'`)
  // Defense in depth at the single application choke point (ownPath rejects
  // this earlier for locally built ops, but replayed/wire ops land here
  // directly): a '__proto__' segment would create a key the document's own
  // JSON ownership boundary rejects, so it never addresses anything.
  if (seg === '__proto__') throw new PatchError(op, `forbidden segment '__proto__'`)
  if (rest.length > 0) {
    // Own-property membership: `in` would walk the prototype chain.
    if (!Object.hasOwn(node, seg) || node[seg] === undefined)
      throw new PatchError(op, `key '${seg}' not found`)
    return Object.freeze({ ...node, [seg]: applyAt(node[seg]!, rest, op) })
  }
  switch (op.op) {
    case 'add': {
      if (Object.hasOwn(node, seg)) throw new PatchError(op, `key '${seg}' already exists`)
      return Object.freeze({ ...node, [seg]: op.value })
    }
    case 'remove': {
      if (!Object.hasOwn(node, seg)) throw new PatchError(op, `key '${seg}' not found`)
      const { [seg]: _removed, ...restObj } = node
      return Object.freeze(restObj)
    }
    case 'replace': {
      if (!Object.hasOwn(node, seg)) throw new PatchError(op, `key '${seg}' not found`)
      return Object.freeze({ ...node, [seg]: op.value })
    }
  }
}

/**
 * Apply ops in order, immutably - TRUSTED fast path. Op values are
 * installed by reference, so every op must already be OWNED: detached,
 * deep-frozen, JSON-valid. The transaction builder and the store's replay
 * guarantee this for the ops they record. Ops from anywhere else (wire,
 * persisted logs, IPC, callers outside this package) must go through
 * `applyOps`, which owns each value first.
 */
export function applyOwnedOps(root: Json, ops: readonly PatchOp[]): Json {
  let cur = root
  for (const op of ops) cur = applyOp(cur, op)
  return cur
}

/**
 * Apply ops in order, immutably - the SAFE ingress choke point for foreign
 * ops (wire, replayed logs, IPC). The ENTIRE batch goes through one
 * ownJson pass (detached, deep-frozen, budgeted copy of the array, every
 * envelope, path, value, and oldValue alike), so a hostile array Proxy,
 * sparse batch, or mid-iteration mutation is consulted exactly once and
 * the node/char budgets are cumulative across the whole batch. Decoding
 * and application read ONLY the owned copy; the foreign input is never
 * touched again - not even to format a rejection (PatchError with
 * undefined patchOp). Hostile values (cycles, accessors, proxies,
 * '__proto__' keys, budget bombs, non-finite numbers) reject with a
 * PatchError; unknown op discriminators reject, never silently interpreted
 * as a replace. applyAt additionally rejects '__proto__' segments and
 * unsafe indices.
 */
export function applyOps(root: Json, ops: unknown): Json {
  const owned = ownJson(ops as Json, { undefinedProps: 'reject' })
  if (!owned.ok) throw new PatchError(undefined, `ops are not JSON: ${owned.reason}`)
  const batch = owned.value
  if (!Array.isArray(batch)) throw new PatchError(undefined, 'ops must be an array')
  let cur = root
  for (let i = 0; i < batch.length; i++) cur = applyOp(cur, decodeOwnedOp(batch[i]!, i))
  return cur
}

/**
 * Strictly decode one ALREADY-OWNED op (plain frozen JSON - safe to read
 * and to quote in diagnostics). Rejections carry the op index, never the
 * foreign original.
 */
function decodeOwnedOp(o: Json, index: number): PatchOp {
  if (!isObject(o)) throw new PatchError(undefined, `ops[${index}] must be an object`)
  const kind = o.op
  if (kind !== 'add' && kind !== 'remove' && kind !== 'replace')
    throw new PatchError(undefined, `ops[${index}]: unknown op kind '${String(kind)}'`)
  const path = o.path
  if (!Array.isArray(path))
    throw new PatchError(undefined, `ops[${index}]: path must be an array of segments`)
  for (const seg of path) {
    // An object segment would coerce to a string inside property access;
    // reject it before it can address anything.
    if (typeof seg !== 'string' && typeof seg !== 'number')
      throw new PatchError(undefined, `ops[${index}]: path segments must be strings or numbers`)
  }
  const segs = path as DocPath
  // Forward remove installs nothing; oldValue (already owned above) rides
  // along only so the op stays self-inverting for the CALLER - inverses of
  // foreign ops must still be applied via applyOps, never the fast path.
  if (kind === 'remove') return { op: 'remove', path: segs, oldValue: o.oldValue ?? null }
  if (!Object.hasOwn(o, 'value'))
    throw new PatchError(undefined, `ops[${index}]: ${kind} requires a value`)
  return kind === 'add'
    ? { op: 'add', path: segs, value: o.value! }
    : { op: 'replace', path: segs, value: o.value!, oldValue: o.oldValue ?? null }
}

/** Invert one op. Pure: every op carries its own inverse data. */
export function invertOp(op: PatchOp): PatchOp {
  switch (op.op) {
    case 'add':
      return { op: 'remove', path: op.path, oldValue: op.value }
    case 'remove':
      return { op: 'add', path: op.path, value: op.oldValue }
    case 'replace':
      return { op: 'replace', path: op.path, value: op.oldValue, oldValue: op.value }
  }
}

/** Invert an op list: reversed order, each op inverted. */
export function invertOps(ops: readonly PatchOp[]): readonly PatchOp[] {
  return ops.map(invertOp).reverse()
}
