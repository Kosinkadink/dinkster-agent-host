/**
 * Dependency-free runtime shape validator for the CURRENT workflow document
 * format (FORMAT_VERSION). Older versions must be migrated first.
 *
 * Semantically equivalent to WORKFLOW_SCHEMA (schema.ts) but produces
 * unified Diagnostics with JSON-path messages instead of ajv error objects.
 * The equivalence is enforced by test/format.schema.test.ts, which runs both
 * over the golden fixtures and a set of corrupted variants.
 *
 * Shape validation only: referential integrity (dangling links, recursion,
 * ID-cursor rules) is the invariant checker's job (../invariants.ts).
 * Unknown properties are allowed everywhere (additive-first policy).
 */

import { diag, type Diagnostic } from '../diagnostics.js'
import { isValidActorId } from '../ids.js'
import {
  FORMAT_VERSION,
  MAX_DYNAMIC_STATE_DEPTH,
  regionContractShapeProblems,
  suppressedDeliveryKey,
  type SuppressedDelivery,
} from './document.js'

const CONTROLLER_MODES = new Set(['fixed', 'increment', 'decrement', 'randomize'])
const NODE_MODES = new Set(['active', 'muted', 'bypassed'])
const PREVIEW_MODES = new Set(['off', 'cheap', 'quality', 'auto'])

class ShapeChecker {
  readonly diags: Diagnostic[] = []

  fail(path: string, msg: string): false {
    this.diags.push(diag('error', 'import', 'doc.shape.invalid', `${path}: ${msg}`))
    return false
  }

  /** Plain object (not null, not array). */
  obj(v: unknown, path: string): v is Record<string, unknown> {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      return this.fail(path, 'expected an object')
    }
    return true
  }

  str(v: unknown, path: string, opts?: { nonEmpty?: boolean }): v is string {
    if (typeof v !== 'string') return this.fail(path, 'expected a string')
    if (opts?.nonEmpty && v.length === 0) return this.fail(path, 'expected a non-empty string')
    return true
  }

  optStr(v: unknown, path: string): boolean {
    return v === undefined || this.str(v, path)
  }

  num(v: unknown, path: string): v is number {
    // Finite only (CO2): Infinity round-trips through neither JSON nor the
    // wire; admitting it here would let it reach geometry and hashing.
    if (typeof v !== 'number' || !Number.isFinite(v)) return this.fail(path, 'expected a finite number')
    return true
  }

  int(v: unknown, path: string, min: number): v is number {
    // Safe integers only (CO7): 1e300 passes Number.isInteger but breaks
    // every +1 allocation cursor that trusts it.
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) {
      return this.fail(path, `expected a safe integer >= ${min}`)
    }
    return true
  }

  bool(v: unknown, path: string): v is boolean {
    if (typeof v !== 'boolean') return this.fail(path, 'expected a boolean')
    return true
  }

  optBool(v: unknown, path: string): boolean {
    if (v !== undefined && typeof v !== 'boolean') return this.fail(path, 'expected a boolean')
    return true
  }

  arr(v: unknown, path: string): v is readonly unknown[] {
    if (!Array.isArray(v)) return this.fail(path, 'expected an array')
    return true
  }

  optExt(v: unknown, path: string): boolean {
    return v === undefined || this.obj(v, path) !== false
  }
}

function checkPortRef(c: ShapeChecker, v: unknown, path: string): void {
  if (!c.obj(v, path)) return
  c.str(v['node'], `${path}.node`, { nonEmpty: true })
  c.str(v['port'], `${path}.port`, { nonEmpty: true })
  // Retired pre-release scalar; loadDocument canonicalizes it away before
  // validation, so its presence here means the pipeline was bypassed.
  if (v['member'] !== undefined) c.fail(`${path}.member`, "retired field; use 'members' (member-id path, outermost first)")
  // Member-id path (outermost first). Canonical: present iff non-empty.
  if (v['members'] !== undefined && c.arr(v['members'], `${path}.members`)) {
    if (v['members'].length === 0) c.fail(`${path}.members`, 'must be non-empty when present (omit for static ports)')
    v['members'].forEach((m, i) => c.str(m, `${path}.members[${i}]`, { nonEmpty: true }))
  }
}

function checkBoundaryBinding(c: ShapeChecker, v: unknown, path: string): void {
  if (!c.obj(v, path)) return
  const binding = v as Record<string, unknown>
  const kind = binding['kind']
  if (kind === 'widgetTap') {
    c.str(binding['node'], `${path}.node`, { nonEmpty: true })
    c.str(binding['tap'], `${path}.tap`, { nonEmpty: true })
    if (binding['port'] !== undefined) c.fail(`${path}.port`, "invalid on kind 'widgetTap'")
    if (binding['members'] !== undefined) c.fail(`${path}.members`, "invalid on kind 'widgetTap'")
    if (binding['slots'] !== undefined) c.fail(`${path}.slots`, "invalid on kind 'widgetTap'")
    return
  }
  checkPortRef(c, v, path)
  if (binding['tap'] !== undefined) c.fail(`${path}.tap`, "invalid on kind 'port' or 'family'")
  if (kind !== 'port' && kind !== 'family' && kind !== 'slot' && kind !== 'dynamicCombo') {
    c.fail(`${path}.kind`, "must be 'port', 'family', 'slot', 'dynamicCombo', or 'widgetTap'")
  }
  // Slot-selective forwarding (hazard F10): family bindings only, non-empty,
  // duplicate-free. Entries are dotted paths over template slot ids ('sub'
  // = whole subtree, 'sub.s' = narrowed); segments must be non-empty, and
  // an entry must not be a strict path-prefix of another (whole-subtree and
  // narrowed selection of the same construct are mutually exclusive). Order
  // is irrelevant (derived template keeps template order) but duplicates
  // would suggest a meaning that does not exist.
  const slots = (v as Record<string, unknown>)['slots']
  if (slots !== undefined) {
    if (kind !== 'family') {
      c.fail(`${path}.slots`, "invalid on kind 'port' (slot selection applies to family forwarding only)")
    }
    if (c.arr(slots, `${path}.slots`)) {
      if (slots.length === 0) c.fail(`${path}.slots`, 'must be non-empty when present (omit to expose the whole template)')
      const seen = new Set<string>()
      slots.forEach((s, i) => {
        if (!c.str(s, `${path}.slots[${i}]`, { nonEmpty: true })) return
        if (s.split('.').some((seg) => seg === '')) {
          c.fail(`${path}.slots[${i}]`, `slot path '${s}' has an empty segment`)
          return
        }
        if (seen.has(s)) c.fail(`${path}.slots[${i}]`, `duplicate slot path '${s}'`)
        seen.add(s)
      })
      slots.forEach((s, i) => {
        if (typeof s !== 'string' || !seen.has(s)) return
        for (const other of seen) {
          if (other.startsWith(`${s}.`)) {
            c.fail(`${path}.slots[${i}]`, `slot path '${s}' (whole subtree) conflicts with narrower '${other}'; list one or the other`)
            break
          }
        }
      })
    }
  }
}

function checkBoundaryItem(c: ShapeChecker, v: unknown, path: string, side: 'inputs' | 'outputs'): void {
  if (!c.obj(v, path)) return
  c.str(v['id'], `${path}.id`, { nonEmpty: true })
  c.optStr(v['displayName'], `${path}.displayName`)
  checkBoundaryBinding(c, v['binds'], `${path}.binds`)
  const primaryBinding = typeof v['binds'] === 'object' && v['binds'] !== null
    ? v['binds'] as Record<string, unknown>
    : undefined
  if (primaryBinding?.['kind'] === 'widgetTap' && side === 'inputs') {
    c.fail(`${path}.binds.kind`, "kind 'widgetTap' is output-side only")
  }
  if (primaryBinding?.['kind'] === 'slot' || primaryBinding?.['kind'] === 'dynamicCombo') {
    if (side === 'outputs') c.fail(`${path}.binds.kind`, 'conditional constructs are input-side only')
    if (v['alsoBinds'] !== undefined) c.fail(`${path}.alsoBinds`, 'conditional constructs cannot fan out')
  }
  // Fan-out (alsoBinds): input-side only, entries match the primary binding
  // kind, are non-empty when present (canonical form omits an empty list),
  // and no target may repeat another (including the primary).
  const alsoBinds = v['alsoBinds']
  if (alsoBinds !== undefined) {
    if (side === 'outputs') {
      c.fail(`${path}.alsoBinds`, 'invalid on boundary outputs (an output has exactly one source)')
    }
    const primary = v['binds']
    const primaryKind = typeof primary === 'object' && primary !== null
      ? (primary as Record<string, unknown>)['kind']
      : undefined
    if (c.arr(alsoBinds, `${path}.alsoBinds`)) {
      if (alsoBinds.length === 0) c.fail(`${path}.alsoBinds`, 'must be non-empty when present (omit for a single binding)')
      const targetKey = (b: unknown): string | undefined => {
        if (typeof b !== 'object' || b === null) return undefined
        const o = b as Record<string, unknown>
        if (typeof o['node'] !== 'string' || typeof o['port'] !== 'string') return undefined
        const members = Array.isArray(o['members']) ? o['members'].join('.') : ''
        return `${o['node']}\u0000${o['port']}\u0000${members}`
      }
      const seen = new Set<string>()
      const primaryKey = targetKey(primary)
      if (primaryKey !== undefined) seen.add(primaryKey)
      alsoBinds.forEach((b, i) => {
        checkBoundaryBinding(c, b, `${path}.alsoBinds[${i}]`)
        if (typeof b === 'object' && b !== null && (b as Record<string, unknown>)['kind'] !== primaryKind) {
          c.fail(`${path}.alsoBinds[${i}]`, `must match primary binding kind '${String(primaryKind)}'`)
        }
        const key = targetKey(b)
        if (key === undefined) return
        if (seen.has(key)) c.fail(`${path}.alsoBinds[${i}]`, 'duplicate fan-out target (same node/port/members as the primary or a previous entry)')
        seen.add(key)
      })
    }
  }
  c.optBool(v['promoted'], `${path}.promoted`)
  // A forwarded family's template always carries its widgets; 'promoted'
  // has no meaning there and canonical form allows only ONE spelling.
  const binds = v['binds']
  if (
    v['promoted'] !== undefined &&
    typeof binds === 'object' &&
    binds !== null &&
    (binds as Record<string, unknown>)['kind'] !== 'port'
  ) {
    c.fail(`${path}.promoted`, 'invalid unless the boundary binds a concrete input port')
  }
  c.optExt(v['ext'], `${path}.ext`)
}

/**
 * Hard nesting budget for dynamic state (hazard N5): one level per family
 * crossed, shared with the JSON Schema's bounded unrolling (schema.ts).
 * State deeper than the elaborator would ever read is malformed, and the
 * validator fails it deterministically instead of recursing without bound.
 */
function checkDynamicPortState(c: ShapeChecker, st: unknown, p: string, depth: number): void {
  if (depth > MAX_DYNAMIC_STATE_DEPTH) {
    c.fail(p, `dynamic state nested deeper than ${MAX_DYNAMIC_STATE_DEPTH} levels`)
    return
  }
  if (!c.obj(st, p)) return
  if (st['members'] !== undefined && c.arr(st['members'], `${p}.members`)) {
    st['members'].forEach((m, i) => c.str(m, `${p}.members[${i}]`, { nonEmpty: true }))
    // Duplicate member ids (CO7) would elaborate one member twice and make
    // per-member state ambiguous - reject the document.
    const seen = new Set<string>()
    for (const m of st['members']) {
      if (typeof m !== 'string') continue
      if (seen.has(m)) {
        c.fail(`${p}.members`, `duplicate member id '${m}'`)
        break
      }
      seen.add(m)
    }
  }
  if (st['selected'] !== undefined) c.str(st['selected'], `${p}.selected`)
  if (st['memberLabels'] !== undefined && c.obj(st['memberLabels'], `${p}.memberLabels`)) {
    for (const [member, label] of Object.entries(st['memberLabels'])) {
      if (member.length === 0) c.fail(`${p}.memberLabels`, 'member ids must be non-empty')
      c.str(label, `${p}.memberLabels.${member}`, { nonEmpty: true })
    }
  }
  if (st['seq'] !== undefined) c.int(st['seq'], `${p}.seq`, 0)
  if (st['memberState'] !== undefined && c.obj(st['memberState'], `${p}.memberState`)) {
    for (const [member, constructs] of Object.entries(st['memberState'])) {
      const mp = `${p}.memberState.${member}`
      if (!c.obj(constructs, mp)) continue
      for (const [construct, nested] of Object.entries(constructs)) {
        checkDynamicPortState(c, nested, `${mp}.${construct}`, depth + 1)
      }
    }
  }
}

function checkRegion(c: ShapeChecker, v: unknown, path: string): void {
  for (const problem of regionContractShapeProblems(v)) c.fail(`${path}${problem.field}`, problem.message)
}

function checkNode(c: ShapeChecker, v: unknown, path: string): void {
  if (!c.obj(v, path)) return
  c.str(v['id'], `${path}.id`, { nonEmpty: true })
  c.str(v['type'], `${path}.type`, { nonEmpty: true })
  if (v['virtual'] !== undefined && v['virtual'] !== true) c.fail(`${path}.virtual`, 'expected true')
  c.obj(v['values'], `${path}.values`)
  if (v['controllers'] !== undefined && c.obj(v['controllers'], `${path}.controllers`)) {
    for (const [k, mode] of Object.entries(v['controllers'])) {
      if (typeof mode !== 'string' || !CONTROLLER_MODES.has(mode)) {
        c.fail(`${path}.controllers.${k}`, `expected one of ${[...CONTROLLER_MODES].join('|')}`)
      }
    }
  }
  if (v['mode'] !== undefined && (typeof v['mode'] !== 'string' || !NODE_MODES.has(v['mode']))) {
    c.fail(`${path}.mode`, `expected one of ${[...NODE_MODES].join('|')}`)
  }
  if (v['dynamic'] !== undefined && c.obj(v['dynamic'], `${path}.dynamic`)) {
    for (const [k, st] of Object.entries(v['dynamic'])) {
      checkDynamicPortState(c, st, `${path}.dynamic.${k}`, 0)
    }
  }
  if (v['region'] !== undefined) checkRegion(c, v['region'], `${path}.region`)
  c.optStr(v['title'], `${path}.title`)
  if (v['previews'] !== undefined && (typeof v['previews'] !== 'string' || !PREVIEW_MODES.has(v['previews']))) {
    c.fail(`${path}.previews`, `expected one of ${[...PREVIEW_MODES].join('|')}`)
  }
  c.optBool(v['mirrorPreviews'], `${path}.mirrorPreviews`)
  c.optExt(v['ext'], `${path}.ext`)
}

/** A link endpoint: a PortRef, a `{reroute}`, a `{valueSource}`, or a `{selector, candidate?}` reference. */
function checkLinkEndpoint(c: ShapeChecker, v: unknown, path: string): void {
  if (!c.obj(v, path)) return
  if ('reroute' in v) {
    c.str(v['reroute'], `${path}.reroute`, { nonEmpty: true })
    return
  }
  if ('valueSource' in v) {
    c.str(v['valueSource'], `${path}.valueSource`, { nonEmpty: true })
    return
  }
  if ('selector' in v) {
    c.str(v['selector'], `${path}.selector`, { nonEmpty: true })
    if (v['candidate'] !== undefined) c.str(v['candidate'], `${path}.candidate`, { nonEmpty: true })
    return
  }
  if ('tap' in v) {
    c.str(v['node'], `${path}.node`, { nonEmpty: true })
    c.str(v['tap'], `${path}.tap`, { nonEmpty: true })
    return
  }
  checkPortRef(c, v, path)
}

function checkLink(c: ShapeChecker, v: unknown, path: string): void {
  if (!c.obj(v, path)) return
  c.str(v['id'], `${path}.id`, { nonEmpty: true })
  checkLinkEndpoint(c, v['from'], `${path}.from`)
  checkLinkEndpoint(c, v['to'], `${path}.to`)
  if (c.obj(v['to'], `${path}.to`) && 'tap' in v['to']) c.fail(`${path}.to`, 'widget taps cannot be link targets')
  c.optExt(v['ext'], `${path}.ext`)
}

function checkOccurrenceRef(c: ShapeChecker, v: unknown, path: string): void {
  if (!c.obj(v, path)) return
  if (c.arr(v['instancePath'], `${path}.instancePath`)) {
    v['instancePath'].forEach((node, index) =>
      c.str(node, `${path}.instancePath[${index}]`, { nonEmpty: true }))
  }
  c.str(v['node'], `${path}.node`, { nonEmpty: true })
}

function checkBoundaryRoute(c: ShapeChecker, v: unknown, path: string): void {
  if (!c.arr(v, path)) return
  if (v.length === 0) c.fail(path, 'must contain at least one authored boundary hop')
  v.forEach((leg, index) => {
    const p = `${path}[${index}]`
    if (!c.obj(leg, p)) return
    c.str(leg['graph'], `${p}.graph`, { nonEmpty: true })
    c.str(leg['boundaryId'], `${p}.boundaryId`, { nonEmpty: true })
    checkBoundaryBinding(c, leg['binding'], `${p}.binding`)
  })
}

function checkOccurrenceEndpoint(
  c: ShapeChecker,
  v: unknown,
  path: string,
  side: 'from' | 'to',
): void {
  if (!c.obj(v, path)) return
  if (v['kind'] === 'body') {
    checkLinkEndpoint(c, v['endpoint'], `${path}.endpoint`)
    if (side === 'to' && c.obj(v['endpoint'], `${path}.endpoint`) && 'tap' in v['endpoint'])
      c.fail(`${path}.endpoint`, 'widget taps cannot be link targets')
    return
  }
  if (v['kind'] !== 'boundary') {
    c.fail(`${path}.kind`, "must be 'body' or 'boundary'")
    return
  }
  checkOccurrenceRef(c, v['occurrence'], `${path}.occurrence`)
  if (c.obj(v['address'], `${path}.address`)) {
    c.str(v['address']['port'], `${path}.address.port`, { nonEmpty: true })
    const members = v['address']['members']
    if (members !== undefined && c.arr(members, `${path}.address.members`)) {
      if (members.length === 0)
        c.fail(`${path}.address.members`, 'must be non-empty when present')
      members.forEach((member, index) =>
        c.str(member, `${path}.address.members[${index}]`, { nonEmpty: true }))
    }
  }
  checkBoundaryRoute(c, v['route'], `${path}.route`)
}

function checkParentDelivery(c: ShapeChecker, v: unknown, path: string): void {
  if (!c.obj(v, path)) return
  c.str(v['graph'], `${path}.graph`, { nonEmpty: true })
  if (v['kind'] === 'link') {
    c.str(v['linkId'], `${path}.linkId`, { nonEmpty: true })
  } else if (v['kind'] === 'netSink') {
    c.str(v['netId'], `${path}.netId`, { nonEmpty: true })
    checkPortRef(c, v['to'], `${path}.to`)
  } else {
    c.fail(`${path}.kind`, "must be 'link' or 'netSink'")
  }
}

function checkSuppressedDelivery(c: ShapeChecker, v: unknown, path: string): void {
  if (!c.obj(v, path)) return
  if (v['kind'] === 'link') {
    c.str(v['linkId'], `${path}.linkId`, { nonEmpty: true })
  } else if (v['kind'] === 'netSink') {
    c.str(v['netId'], `${path}.netId`, { nonEmpty: true })
    checkPortRef(c, v['to'], `${path}.to`)
  } else if (v['kind'] === 'projectedLeg') {
    checkParentDelivery(c, v['delivery'], `${path}.delivery`)
    checkBoundaryRoute(c, v['route'], `${path}.route`)
  } else {
    c.fail(`${path}.kind`, "must be 'link', 'netSink', or 'projectedLeg'")
  }
}

function checkOccurrenceTopology(c: ShapeChecker, v: unknown, path: string): void {
  if (!c.obj(v, path)) return
  checkOccurrenceRef(c, v['owner'], `${path}.owner`)
  c.str(v['bodyGraph'], `${path}.bodyGraph`, { nonEmpty: true })
  if (c.obj(v['links'], `${path}.links`)) {
    for (const [key, link] of Object.entries(v['links'])) {
      const p = `${path}.links.${key}`
      if (!c.obj(link, p)) continue
      c.str(link['id'], `${p}.id`, { nonEmpty: true })
      checkOccurrenceEndpoint(c, link['from'], `${p}.from`, 'from')
      checkOccurrenceEndpoint(c, link['to'], `${p}.to`, 'to')
      c.optExt(link['ext'], `${p}.ext`)
    }
  }
  if (v['suppressedDeliveries'] !== undefined &&
      c.arr(v['suppressedDeliveries'], `${path}.suppressedDeliveries`)) {
    const suppressions = v['suppressedDeliveries']
    if (suppressions.length === 0)
      c.fail(`${path}.suppressedDeliveries`, 'must be omitted when empty')
    suppressions.forEach((delivery, index) =>
      checkSuppressedDelivery(c, delivery, `${path}.suppressedDeliveries[${index}]`))
    try {
      const keys = suppressions.map((delivery) =>
        suppressedDeliveryKey(delivery as SuppressedDelivery))
      for (let index = 1; index < keys.length; index++) {
        if (keys[index - 1]! >= keys[index]!) {
          c.fail(`${path}.suppressedDeliveries`, 'must be sorted and duplicate-free in canonical order')
          break
        }
      }
    } catch {
      // Shape diagnostics above own malformed entries.
    }
  }
  c.int(v['nextOrdinal'], `${path}.nextOrdinal`, 0)
  if (v['actorCursors'] !== undefined && c.obj(v['actorCursors'], `${path}.actorCursors`)) {
    for (const [actor, cursor] of Object.entries(v['actorCursors'])) {
      if (!isValidActorId(actor))
        c.fail(`${path}.actorCursors`, `actor key ${JSON.stringify(actor)} is not a valid actor id (safe set: [A-Za-z0-9_-]+, '__proto__' reserved)`)
      c.int(cursor, `${path}.actorCursors.${actor}`, 0)
    }
  }
  c.optExt(v['ext'], `${path}.ext`)
}

export function validateOccurrenceTopologyShape(json: unknown): readonly Diagnostic[] {
  const c = new ShapeChecker()
  checkOccurrenceTopology(c, json, '$.occurrenceTopology')
  return c.diags
}

function checkReroute(c: ShapeChecker, v: unknown, path: string): void {
  if (!c.obj(v, path)) return
  c.str(v['id'], `${path}.id`, { nonEmpty: true })
  c.optExt(v['ext'], `${path}.ext`)
}

const VS_CONTROLLER_SLOTS = new Set(['after_generate', 'after_refresh'])

/** Declared partial widget spec on a value source (all fields optional). */
function checkDeclaredSpec(c: ShapeChecker, v: unknown, path: string): void {
  if (!c.obj(v, path)) return
  c.optStr(v['widgetType'], `${path}.widgetType`)
  if (v['options'] !== undefined) c.obj(v['options'], `${path}.options`)
  if (v['controller'] !== undefined && (typeof v['controller'] !== 'string' || !VS_CONTROLLER_SLOTS.has(v['controller']))) {
    c.fail(`${path}.controller`, `expected one of ${[...VS_CONTROLLER_SLOTS].join('|')}`)
  }
}

function checkValueSource(c: ShapeChecker, v: unknown, path: string): void {
  if (!c.obj(v, path)) return
  c.str(v['id'], `${path}.id`, { nonEmpty: true })
  if (!('value' in v)) c.fail(`${path}.value`, 'expected a JSON value (may be null, never absent)')
  if (v['spec'] !== undefined) checkDeclaredSpec(c, v['spec'], `${path}.spec`)
  if (v['controller'] !== undefined && (typeof v['controller'] !== 'string' || !CONTROLLER_MODES.has(v['controller']))) {
    c.fail(`${path}.controller`, `expected one of ${[...CONTROLLER_MODES].join('|')}`)
  }
  c.optStr(v['title'], `${path}.title`)
  c.optExt(v['ext'], `${path}.ext`)
}

function checkSelector(c: ShapeChecker, v: unknown, path: string): void {
  if (!c.obj(v, path)) return
  c.str(v['id'], `${path}.id`, { nonEmpty: true })
  if (c.arr(v['candidates'], `${path}.candidates`)) {
    v['candidates'].forEach((cand, i) => {
      const p = `${path}.candidates[${i}]`
      if (!c.obj(cand, p)) return
      c.str(cand['id'], `${p}.id`, { nonEmpty: true })
      c.optStr(cand['title'], `${p}.title`)
    })
  }
  const policy = v['policy']
  if (c.obj(policy, `${path}.policy`)) {
    const kind = policy['kind']
    if (kind === 'fixed') {
      c.str(policy['candidate'], `${path}.policy.candidate`, { nonEmpty: true })
    } else if (kind !== 'random') {
      c.fail(`${path}.policy.kind`, `expected 'fixed' or 'random', got '${String(kind)}'`)
    }
  }
  c.optStr(v['title'], `${path}.title`)
  c.optExt(v['ext'], `${path}.ext`)
}

function checkNet(c: ShapeChecker, v: unknown, path: string): void {
  if (!c.obj(v, path)) return
  c.str(v['id'], `${path}.id`, { nonEmpty: true })
  c.str(v['name'], `${path}.name`, { nonEmpty: true })
  checkPortRef(c, v['source'], `${path}.source`)
  if (c.arr(v['sinks'], `${path}.sinks`)) {
    v['sinks'].forEach((s, i) => checkPortRef(c, s, `${path}.sinks[${i}]`))
  }
  c.optExt(v['ext'], `${path}.ext`)
}

function checkGraphDef(c: ShapeChecker, v: unknown, path: string): void {
  if (!c.obj(v, path)) return
  c.str(v['id'], `${path}.id`, { nonEmpty: true })
  c.str(v['name'], `${path}.name`)
  if (c.obj(v['nodes'], `${path}.nodes`)) {
    for (const [k, n] of Object.entries(v['nodes'])) checkNode(c, n, `${path}.nodes.${k}`)
  }
  if (c.obj(v['links'], `${path}.links`)) {
    for (const [k, l] of Object.entries(v['links'])) checkLink(c, l, `${path}.links.${k}`)
  }
  if (c.obj(v['nets'], `${path}.nets`)) {
    for (const [k, n] of Object.entries(v['nets'])) checkNet(c, n, `${path}.nets.${k}`)
  }
  if (c.obj(v['reroutes'], `${path}.reroutes`)) {
    for (const [k, r] of Object.entries(v['reroutes'])) checkReroute(c, r, `${path}.reroutes.${k}`)
  }
  if (v['valueSources'] !== undefined && c.obj(v['valueSources'], `${path}.valueSources`)) {
    for (const [k, s] of Object.entries(v['valueSources'])) checkValueSource(c, s, `${path}.valueSources.${k}`)
  }
  if (v['selectors'] !== undefined && c.obj(v['selectors'], `${path}.selectors`)) {
    for (const [k, s] of Object.entries(v['selectors'])) checkSelector(c, s, `${path}.selectors.${k}`)
  }
  if (v['boundary'] !== undefined && c.obj(v['boundary'], `${path}.boundary`)) {
    for (const side of ['inputs', 'outputs'] as const) {
      const items = v['boundary'][side]
      if (c.arr(items, `${path}.boundary.${side}`)) {
        items.forEach((it, i) => checkBoundaryItem(c, it, `${path}.boundary.${side}[${i}]`, side))
      }
    }
  }
  c.int(v['nextOrdinal'], `${path}.nextOrdinal`, 0)
  if (v['actorCursors'] !== undefined && c.obj(v['actorCursors'], `${path}.actorCursors`)) {
    for (const [actor, cursor] of Object.entries(v['actorCursors'])) {
      // Keys are actor ids embedded verbatim in allocated ids, so only the
      // safe id alphabet is loadable (dispatch enforces the same set).
      if (!isValidActorId(actor)) c.fail(`${path}.actorCursors`, `actor key ${JSON.stringify(actor)} is not a valid actor id (safe set: [A-Za-z0-9_-]+, '__proto__' reserved)`)
      c.int(cursor, `${path}.actorCursors.${actor}`, 0)
    }
  }
  c.optExt(v['ext'], `${path}.ext`)
}

function checkSurface(c: ShapeChecker, v: unknown, path: string): void {
  if (!c.obj(v, path)) return
  c.str(v['id'], `${path}.id`, { nonEmpty: true })
  c.str(v['type'], `${path}.type`, { nonEmpty: true })
  c.obj(v['config'], `${path}.config`)
  c.optExt(v['ext'], `${path}.ext`)
}

function checkVec2(c: ShapeChecker, v: unknown, path: string): void {
  if (!c.obj(v, path)) return
  c.num(v['x'], `${path}.x`)
  c.num(v['y'], `${path}.y`)
}

function checkNodeView(c: ShapeChecker, v: unknown, path: string): void {
  if (!c.obj(v, path)) return
  if (v['position'] !== undefined) checkVec2(c, v['position'], `${path}.position`)
  if (v['size'] !== undefined && c.obj(v['size'], `${path}.size`)) {
    c.num(v['size']['width'], `${path}.size.width`)
    c.num(v['size']['height'], `${path}.size.height`)
  }
  c.optBool(v['collapsed'], `${path}.collapsed`)
  if (v['views'] !== undefined && c.obj(v['views'], `${path}.views`)) {
    for (const [k, view] of Object.entries(v['views'])) c.str(view, `${path}.views.${k}`)
  }
  if (v['sections'] !== undefined && c.obj(v['sections'], `${path}.sections`)) {
    for (const [k, s] of Object.entries(v['sections'])) {
      if (c.obj(s, `${path}.sections.${k}`)) c.bool(s['collapsed'], `${path}.sections.${k}.collapsed`)
    }
  }
  c.optStr(v['color'], `${path}.color`)
  c.optExt(v['ext'], `${path}.ext`)
}

function checkGroupView(c: ShapeChecker, key: string, v: unknown, path: string): void {
  if (!c.obj(v, path)) return
  c.str(v['id'], `${path}.id`, { nonEmpty: true })
  if (typeof v['id'] === 'string' && v['id'] !== key) {
    c.fail(`${path}.id`, `group key '${key}' != id '${v['id']}'`)
  }
  c.str(v['title'], `${path}.title`)
  if (c.obj(v['bounds'], `${path}.bounds`)) {
    for (const f of ['x', 'y', 'width', 'height'] as const) {
      c.num(v['bounds'][f], `${path}.bounds.${f}`)
    }
  }
  c.optStr(v['color'], `${path}.color`)
  c.optExt(v['ext'], `${path}.ext`)
}

function checkRerouteView(c: ShapeChecker, v: unknown, path: string): void {
  if (!c.obj(v, path)) return
  checkVec2(c, v['position'], `${path}.position`)
  c.optExt(v['ext'], `${path}.ext`)
}

function checkValueSourceView(c: ShapeChecker, v: unknown, path: string): void {
  if (!c.obj(v, path)) return
  checkVec2(c, v['position'], `${path}.position`)
  c.optStr(v['view'], `${path}.view`)
  c.optExt(v['ext'], `${path}.ext`)
}

function checkSelectorView(c: ShapeChecker, v: unknown, path: string): void {
  if (!c.obj(v, path)) return
  checkVec2(c, v['position'], `${path}.position`)
  c.optExt(v['ext'], `${path}.ext`)
}

function checkGraphView(c: ShapeChecker, v: unknown, path: string): void {
  if (!c.obj(v, path)) return
  if (c.obj(v['nodes'], `${path}.nodes`)) {
    for (const [k, n] of Object.entries(v['nodes'])) checkNodeView(c, n, `${path}.nodes.${k}`)
  }
  if (v['reroutes'] !== undefined && c.obj(v['reroutes'], `${path}.reroutes`)) {
    for (const [k, r] of Object.entries(v['reroutes'])) checkRerouteView(c, r, `${path}.reroutes.${k}`)
  }
  if (v['valueSources'] !== undefined && c.obj(v['valueSources'], `${path}.valueSources`)) {
    for (const [k, s] of Object.entries(v['valueSources'])) checkValueSourceView(c, s, `${path}.valueSources.${k}`)
  }
  if (v['selectors'] !== undefined && c.obj(v['selectors'], `${path}.selectors`)) {
    for (const [k, s] of Object.entries(v['selectors'])) checkSelectorView(c, s, `${path}.selectors.${k}`)
  }
  if (v['groups'] !== undefined && c.obj(v['groups'], `${path}.groups`)) {
    for (const [k, g] of Object.entries(v['groups'])) checkGroupView(c, k, g, `${path}.groups.${k}`)
  }
  if (v['groupSeq'] !== undefined) c.int(v['groupSeq'], `${path}.groupSeq`, 0)
  if (v['collapsedNets'] !== undefined && c.arr(v['collapsedNets'], `${path}.collapsedNets`)) {
    v['collapsedNets'].forEach((n, i) => c.str(n, `${path}.collapsedNets[${i}]`))
  }
  if (v['guideNets'] !== undefined && c.arr(v['guideNets'], `${path}.guideNets`)) {
    v['guideNets'].forEach((n, i) => c.str(n, `${path}.guideNets[${i}]`))
  }
  if (v['boundary'] !== undefined && c.obj(v['boundary'], `${path}.boundary`)) {
    for (const [k, b] of Object.entries(v['boundary'])) {
      const p = `${path}.boundary.${k}`
      if (k !== 'inputs' && k !== 'outputs') {
        c.fail(p, `boundary side must be 'inputs' or 'outputs', got '${k}'`)
        continue
      }
      if (!c.obj(b, p)) continue
      checkVec2(c, b['position'], `${p}.position`)
      c.optExt(b['ext'], `${p}.ext`)
    }
  }
  c.optExt(v['ext'], `${path}.ext`)
}

function checkView(c: ShapeChecker, v: unknown, path: string): void {
  if (!c.obj(v, path)) return
  if (c.obj(v['graphs'], `${path}.graphs`)) {
    for (const [k, g] of Object.entries(v['graphs'])) checkGraphView(c, g, `${path}.graphs.${k}`)
  }
  if (v['surfaces'] !== undefined && c.obj(v['surfaces'], `${path}.surfaces`)) {
    for (const [k, s] of Object.entries(v['surfaces'])) c.obj(s, `${path}.surfaces.${k}`)
  }
  if (v['bookmarks'] !== undefined && c.obj(v['bookmarks'], `${path}.bookmarks`)) {
    for (const [k, b] of Object.entries(v['bookmarks'])) checkBookmark(c, b, `${path}.bookmarks.${k}`)
  }
  c.optExt(v['ext'], `${path}.ext`)
}

function checkBookmark(c: ShapeChecker, v: unknown, path: string): void {
  if (!c.obj(v, path)) return
  if (c.arr(v['graphStack'], `${path}.graphStack`)) {
    if (v['graphStack'].length < 1) c.fail(`${path}.graphStack`, 'graphStack must have at least 1 entry')
    v['graphStack'].forEach((g, i) => c.str(g, `${path}.graphStack[${i}]`))
  }
  if (c.arr(v['instancePath'], `${path}.instancePath`)) {
    v['instancePath'].forEach((n, i) => c.str(n, `${path}.instancePath[${i}]`))
  }
  const hasViewport = v['viewport'] !== undefined
  const hasView = v['view'] !== undefined
  if (hasViewport === hasView) c.fail(path, "bookmark must contain exactly one of 'view' or legacy 'viewport'")
  if (hasViewport && c.obj(v['viewport'], `${path}.viewport`)) {
    c.num(v['viewport']['x'], `${path}.viewport.x`)
    c.num(v['viewport']['y'], `${path}.viewport.y`)
    if (c.num(v['viewport']['scale'], `${path}.viewport.scale`) && v['viewport']['scale'] <= 0)
      c.fail(`${path}.viewport.scale`, 'scale must be > 0')
  }
  if (hasView && c.obj(v['view'], `${path}.view`)) {
    c.num(v['view']['x'], `${path}.view.x`)
    c.num(v['view']['y'], `${path}.view.y`)
    for (const field of ['width', 'height'] as const) {
      if (c.num(v['view'][field], `${path}.view.${field}`) && v['view'][field] <= 0)
        c.fail(`${path}.view.${field}`, `${field} must be > 0`)
    }
  }
  c.optExt(v['ext'], `${path}.ext`)
}

/**
 * Validate that `json` has the shape of ONE graph definition. Used by
 * subgraph.import to reject malformed defs before they enter a document
 * (the invariant checker assumes shaped input and must never see garbage).
 */
export function validateGraphDefShape(json: unknown, path = '$'): readonly Diagnostic[] {
  const c = new ShapeChecker()
  checkGraphDef(c, json, path)
  return c.diags
}

/** Validate that `json` has the shape of one graph's view state. */
export function validateGraphViewShape(json: unknown, path = '$'): readonly Diagnostic[] {
  const c = new ShapeChecker()
  checkGraphView(c, json, path)
  return c.diags
}

/**
 * Validate that clipboard records carry the SAME per-entity shapes the
 * document loader enforces (node data incl. mode/controllers/dynamic,
 * link endpoints, views, groups), so a paste can never commit a document
 * that loadDocument would then reject. Ids are validated as nonempty
 * strings only - materialization replaces them with fresh mints.
 */
export function validateClipboardRecords(records: {
  readonly nodes: readonly { readonly data: unknown; readonly view: unknown }[]
  readonly links: readonly unknown[]
  readonly reroutes: readonly { readonly data: unknown; readonly view: unknown }[]
  readonly groups: readonly unknown[]
}): readonly Diagnostic[] {
  const c = new ShapeChecker()
  records.nodes.forEach((n, i) => {
    checkNode(c, n.data, `$.nodes[${i}].data`)
    checkNodeView(c, n.view, `$.nodes[${i}].view`)
  })
  records.links.forEach((l, i) => checkLink(c, l, `$.links[${i}]`))
  records.reroutes.forEach((r, i) => {
    checkReroute(c, r.data, `$.reroutes[${i}].data`)
    checkRerouteView(c, r.view, `$.reroutes[${i}].view`)
  })
  records.groups.forEach((g, i) => {
    // The group's source key is its own id (fresh id minted at paste), so
    // the key==id consistency check is vacuous here by construction.
    const id = (g as Record<string, unknown> | null)?.['id']
    checkGroupView(c, typeof id === 'string' ? id : '', g, `$.groups[${i}]`)
  })
  return c.diags
}

/**
 * Validate that `json` has the shape of a current-version WorkflowDocument.
 * Returns error-level diagnostics for every violation (does not stop at the
 * first). `expectedVersion` exists so pipeline tests can validate synthetic
 * migration targets; production callers use the default.
 */
export function validateDocumentShape(
  json: unknown,
  expectedVersion: number = FORMAT_VERSION,
): readonly Diagnostic[] {
  const c = new ShapeChecker()
  if (!c.obj(json, '$')) return c.diags
  if (json['format'] !== 'dinkster-workflow') {
    c.fail('$.format', "expected 'dinkster-workflow'")
  }
  // Shape validation runs AFTER migration, so only the target version is valid.
  if (c.int(json['formatVersion'], '$.formatVersion', 1) && json['formatVersion'] !== expectedVersion) {
    c.fail('$.formatVersion', `expected version ${expectedVersion}, got ${json['formatVersion']} (older documents must pass through migrateJson/loadDocument first)`)
  }
  c.str(json['lineage'], '$.lineage', { nonEmpty: true })
  c.str(json['root'], '$.root', { nonEmpty: true })
  if (c.obj(json['graphs'], '$.graphs')) {
    for (const [k, g] of Object.entries(json['graphs'])) checkGraphDef(c, g, `$.graphs.${k}`)
  }
  if (json['occurrenceTopologies'] !== undefined &&
      c.obj(json['occurrenceTopologies'], '$.occurrenceTopologies')) {
    for (const [key, topology] of Object.entries(json['occurrenceTopologies']))
      checkOccurrenceTopology(c, topology, `$.occurrenceTopologies.${key}`)
  }
  if (json['surfaces'] !== undefined && c.obj(json['surfaces'], '$.surfaces')) {
    for (const [k, s] of Object.entries(json['surfaces'])) checkSurface(c, s, `$.surfaces.${k}`)
  }
  if (json['surfaceSeq'] !== undefined) c.int(json['surfaceSeq'], '$.surfaceSeq', 0)
  if (json['previews'] !== undefined && (typeof json['previews'] !== 'string' || !PREVIEW_MODES.has(json['previews']))) {
    c.fail('$.previews', `expected one of ${[...PREVIEW_MODES].join('|')}`)
  }
  checkView(c, json['view'], '$.view')
  if (json['meta'] !== undefined && c.obj(json['meta'], '$.meta')) {
    for (const f of ['title', 'description', 'created', 'modified'] as const) {
      c.optStr(json['meta'][f], `$.meta.${f}`)
    }
    c.optExt(json['meta']['ext'], '$.meta.ext')
  }
  c.optExt(json['ext'], '$.ext')
  return c.diags
}
