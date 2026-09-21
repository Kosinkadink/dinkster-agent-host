/**
 * Replacement rule registry: the layered lookup behind deprecation upgrades.
 *
 * Rules arrive from three sources with fixed precedence (spec section 2):
 *   'schema' - the successor's own NodeSchema ships the rule (self-describing)
 *   'pack'   - pack-shipped rule files, registered through the extension API
 *   'core'   - the core-maintained table of historical renames
 *
 * Lookup returns every rule for a source type ordered schema > pack > core
 * (registration order within a layer); the caller applies the FIRST rule
 * that plans successfully. Several rules for one source type are legitimate
 * (guarded/versioned alternatives tried in order), so registration appends
 * within a layer; only malformed rules are rejected, with diagnostics.
 */

import type { Diagnostic } from '../diagnostics.js'
import { isReplacementRule, type ReplacementRule, type RuleLayer } from './model.js'

const LAYER_ORDER: readonly RuleLayer[] = ['schema', 'pack', 'core']

export interface ReplacementRegistry {
  /** Validate + add a rule (Json from packs is fine). Returns diagnostics on reject. */
  register(layer: RuleLayer, rule: unknown): readonly Diagnostic[]
  /** All rules migrating `fromType`, layered schema > pack > core. */
  rulesFor(fromType: string): readonly ReplacementRule[]
  /** Every source type any rule migrates (for load-time scans). */
  sourceTypes(): ReadonlySet<string>
}

export function createReplacementRegistry(): ReplacementRegistry {
  const byLayer = new Map<RuleLayer, Map<string, ReplacementRule[]>>(
    LAYER_ORDER.map((l) => [l, new Map<string, ReplacementRule[]>()]),
  )

  return {
    register(layer, rule) {
      if (!isReplacementRule(rule)) {
        return [
          {
            severity: 'error',
            origin: 'schema',
            code: 'replace.rule.invalid',
            message: 'replacement rule rejected: malformed shape (see ReplacementRule; the last case must be unconditional)',
          } satisfies Diagnostic,
        ]
      }
      const rules = byLayer.get(layer)!
      const existing = rules.get(rule.from)
      if (existing) existing.push(rule)
      else rules.set(rule.from, [rule])
      return []
    },
    rulesFor(fromType) {
      const out: ReplacementRule[] = []
      for (const layer of LAYER_ORDER) out.push(...(byLayer.get(layer)!.get(fromType) ?? []))
      return out
    },
    sourceTypes() {
      const out = new Set<string>()
      for (const layer of LAYER_ORDER) for (const key of byLayer.get(layer)!.keys()) out.add(key)
      return out
    },
  }
}
