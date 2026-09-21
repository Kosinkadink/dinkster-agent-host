/**
 * Synthesized legacy-name migration rules. Native schemas declare the
 * historical type names they answer to (NodeSchema.aliases - e.g. the bare
 * ComfyUI class_type 'EmptyImage' for 'comfy.EmptyImage'). Alias RESOLUTION
 * alone renders such nodes, but leaves the document stale in a way that
 * still breaks: documents authored against the old object-info decoder key
 * links on synthesized positional output ids ('out0', 'out1', ...; see
 * schema/object-info.ts), while native schemas carry semantic output ids
 * ('image'). Solve then reports portMissing and the workflow cannot run.
 *
 * So each alias becomes an ordinary replacement rule - the designed
 * migration mechanism, with its review/undo semantics - that renames the
 * node to the canonical type, identity-copies every static input (legacy
 * comfy input ids are preserved verbatim by the compat pack), and remaps
 * positional 'out{i}' onto the i-th static output. Positional order is the
 * ONLY mapping a legacy document affords, and it is sound for the same
 * reason 'out{i}' was synthesized from index in the first place: output
 * order is append-only in practice.
 *
 * Precedence: register these at the 'core' layer AFTER any explicit rules,
 * so a schema- or pack-shipped rule for the same legacy name always wins.
 *
 * Deliberate non-goals, all of which degrade to loud review items rather
 * than silent breakage:
 * - an alias two schemas claim is skipped (mirrors resolution ambiguity)
 * - an alias colliding with a real canonical id is skipped (canonical wins)
 * - dynamic families are not mapped (rules address static ids only)
 * - a legacy-typed node whose links already use semantic output ids plans
 *   with a dropped-connection WARNING and lands in review, never auto-apply
 */
import { inputsOf, outputsOf, type NodeSchema } from '../schema/model.js'
import type { MappingSource, ReplacementRule } from './model.js'

/**
 * Build one rule per (schema, alias) pair. Pure derivation from schema data;
 * call it on a backend's full schema set so ambiguity is judged globally.
 */
export function synthesizeAliasRules(schemas: Iterable<NodeSchema>): readonly ReplacementRule[] {
  const all = [...schemas]
  const canonical = new Set(all.map((s) => s.type))
  const claims = new Map<string, number>()
  for (const s of all) for (const a of s.aliases ?? []) claims.set(a, (claims.get(a) ?? 0) + 1)

  const rules: ReplacementRule[] = []
  for (const schema of all) {
    for (const alias of schema.aliases ?? []) {
      if (alias === schema.type || canonical.has(alias) || (claims.get(alias) ?? 0) > 1) continue
      const inputs: Record<string, MappingSource> = {}
      for (const spec of inputsOf(schema)) {
        if (spec.dynamic !== undefined) continue
        inputs[spec.id] = { kind: 'copy', input: spec.id }
      }
      const outputs: Record<string, string> = {}
      outputsOf(schema)
        .filter((o) => o.dynamic === undefined)
        .forEach((o, i) => {
          outputs[o.id] = `out${i}`
        })
      rules.push({
        from: alias,
        note: `legacy name for '${schema.type}'`,
        cases: [
          {
            to: schema.type,
            ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
            ...(Object.keys(outputs).length > 0 ? { outputs } : {}),
          },
        ],
      })
    }
  }
  return rules
}
