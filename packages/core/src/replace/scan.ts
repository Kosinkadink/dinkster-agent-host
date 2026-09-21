/**
 * Replacement orchestration: document scan + apply helpers over the rule
 * registry and planner. Pure functions - the app decides WHEN to scan
 * (document open, schemas loaded) and WHICH plans to dispatch (auto-apply
 * safe plans by default; a review toggle drops everything to review).
 *
 * Rules CHAIN: A's rule migrates to B, and B is itself migrated by another
 * rule to C. A hop can transform values and move links, so a chain is never
 * shortcut A -> C; each hop is planned against the document state the
 * PREVIOUS hop produced (scratch-applied via the real `node.replace`
 * command, so plan staleness guards hold by construction). A scan item is
 * therefore a chain of one or more hops ending 'terminal' (no rule migrates
 * the final type), or stopped early: 'blocked' (a later hop failed to plan
 * - the planned prefix survives for review), 'cycle' (a hop would revisit a
 * type), or 'depth' (runaway chain).
 *
 * A scan item is `safe` when the chain is terminal and EVERY hop planned
 * with no warning or error. Informational migration archives remain safe.
 * Applying N
 * items batches every hop of every item into ONE `batch` dispatch = one
 * revision, one undo step, all-or-nothing (the batch command runs each
 * sub-invocation against the transaction's working copy, so later hops see
 * earlier writes).
 */

import { createTransactionBuilder, type CommandInvocation } from '../commands/contract.js'
import { REPLACE_COMMANDS } from '../commands/replace-commands.js'
import type { Diagnostic } from '../diagnostics.js'
import type { Json, WorkflowDocument } from '../format/document.js'
import type { NodeSchema } from '../schema/model.js'
import type { ReplacementRule } from './model.js'
import { planReplacement, type NodeReplacePlan, type ReplacementSchemaResolver } from './plan.js'
import type { ReplacementRegistry } from './registry.js'

/** The one command that applies plans - reused here to scratch-apply hops. */
const nodeReplaceCommand = REPLACE_COMMANDS.find((c) => c.id === 'node.replace')!

// ---------------------------------------------------------------------------
// Schema-shipped rule collection
// ---------------------------------------------------------------------------

/**
 * Register every rule the given schemas ship (NodeSchema.replacements) at
 * the 'schema' layer. Malformed rules are skipped with diagnostics naming
 * the shipping schema; call once per registry when a backend's schemas load.
 */
export function registerSchemaRules(
  registry: ReplacementRegistry,
  schemas: Iterable<NodeSchema>,
): readonly Diagnostic[] {
  const diags: Diagnostic[] = []
  for (const schema of schemas) {
    for (const rule of schema.replacements ?? []) {
      const rejected = registry.register('schema', rule)
      diags.push(
        ...rejected.map((d) => ({ ...d, message: `${d.message} (shipped by schema '${schema.type}')` })),
      )
    }
  }
  return diags
}

// ---------------------------------------------------------------------------
// Document scan
// ---------------------------------------------------------------------------

/** A rule may chain this many hops before the scan calls it runaway. */
export const REPLACEMENT_CHAIN_LIMIT = 8

/** One planned migration step: rule matched, plan computed, zero errors. */
export interface ReplacementChainHop {
  readonly rule: ReplacementRule
  readonly plan: NodeReplacePlan
  /** The hop's plan warnings (a warned hop makes the whole item unsafe). */
  readonly diagnostics: readonly Diagnostic[]
}

export type ReplacementChainStatus =
  /** No rule migrates the final type - the chain ran to completion. */
  | 'terminal'
  /** A hop failed to plan; the planned prefix survives for review. */
  | 'blocked'
  /** The next hop would revisit an already-visited type. */
  | 'cycle'
  /** REPLACEMENT_CHAIN_LIMIT hops planned and rules still apply. */
  | 'depth'

export interface ReplacementScanItem {
  readonly graphId: string
  readonly nodeId: string
  readonly sourceType: string
  /**
   * Planned hops in application order. Hop N was planned against the
   * document state hop N-1 produces - never against the original document.
   * Empty when the very first hop failed to plan.
   */
  readonly hops: readonly ReplacementChainHop[]
  /** Node type after the last planned hop (sourceType when hops is empty). */
  readonly terminalType: string
  readonly status: ReplacementChainStatus
  /** First hop's rule (absent when every rule errored) - the common case. */
  readonly rule?: ReplacementRule
  /** First hop's plan - kept for single-hop consumers (badges, popovers). */
  readonly plan?: NodeReplacePlan
  /** Every hop's warnings, plus the blocking hop's errors when stopped. */
  readonly diagnostics: readonly Diagnostic[]
  /** Terminal chain, every hop zero-warning - eligible for auto-apply. */
  readonly safe: boolean
}

/**
 * Plan one node's full migration chain. Rules are tried in registry order
 * (schema > pack > core); the first that PLANS wins - a later rule is never
 * consulted once one produces a plan, even a warned one. Each accepted hop
 * is scratch-applied through the real `node.replace` command and the next
 * hop planned against the result.
 */
function planChain(
  document: WorkflowDocument,
  graphId: string,
  nodeId: string,
  sourceType: string,
  registry: ReplacementRegistry,
  resolve: ReplacementSchemaResolver,
): ReplacementScanItem {
  const hops: ReplacementChainHop[] = []
  const diagnostics: Diagnostic[] = []
  const seen = new Set<string>([sourceType])
  const appliedSameTypeMigrations = new Set<ReplacementRule>()
  const createdLinkIds = new Set<string>()
  let scratch = document
  let currentType = sourceType
  let status: ReplacementChainStatus = 'terminal'
  for (;;) {
    const rules = registry.rulesFor(currentType).filter((rule) => !appliedSameTypeMigrations.has(rule))
    if (rules.length === 0) break
    if (hops.length >= REPLACEMENT_CHAIN_LIMIT) {
      status = 'depth'
      break
    }
    const failures: Diagnostic[] = []
    let hop: ReplacementChainHop | undefined
    for (const rule of rules) {
      const out = planReplacement(scratch, graphId, nodeId, rule, resolve)
      if (out.plan) {
        hop = { rule, plan: out.plan, diagnostics: out.diagnostics }
        break
      }
      if (rule.migration !== undefined) {
        if (out.diagnostics.length === 0) continue
        failures.push(...out.diagnostics)
        break
      }
      failures.push(...out.diagnostics)
    }
    if (!hop) {
      if (failures.length > 0) {
        status = 'blocked'
        diagnostics.push(...failures)
      }
      break
    }
    const referencesCreatedLink = [
      ...hop.plan.inputRewires.map((rewire) => rewire.link),
      ...hop.plan.outputRewires.map((rewire) => rewire.link),
      ...hop.plan.dropLinks,
    ].some((linkId) => createdLinkIds.has(linkId))
    if (referencesCreatedLink) {
      status = 'blocked'
      diagnostics.push({
        severity: 'error',
        origin: 'command',
        code: 'replace.chain.createdLink',
        message: `replace: a later hop for '${nodeId}' references an internal link created by an earlier hop; apply the prefix and rescan`,
      })
      break
    }
    const sameTypeMigration = hop.rule.migration !== undefined && hop.plan.to === currentType
    if (seen.has(hop.plan.to) && !sameTypeMigration) {
      // The looping hop is dropped, not applied: migrating back to a
      // visited type is churn, never progress.
      status = 'cycle'
      break
    }
    const linksBefore = new Set(Object.keys(scratch.graphs[graphId]!.links))
    const tx = createTransactionBuilder(scratch)
    const applyDiags = nodeReplaceCommand.run(
      scratch,
      { plan: hop.plan } as unknown as Json,
      tx,
      { kind: 'initial', schemaResolverFor: () => (type) => resolve(type, 'target') },
    )
    if (applyDiags.some((d) => d.severity === 'error')) {
      // Defensive: the plan was computed against this exact scratch state,
      // so a failed apply means a planner/command disagreement - surface it.
      status = 'blocked'
      diagnostics.push(...applyDiags)
      break
    }
    const nextScratch = tx.result().doc
    if (sameTypeMigration) {
      const repeated = planReplacement(nextScratch, graphId, nodeId, hop.rule, resolve)
      if (repeated.plan !== undefined) {
        status = 'blocked'
        diagnostics.push({
          severity: 'error',
          origin: 'command',
          code: 'replace.migration.nonOneShot',
          message: `replace: same-type migration for '${nodeId}' remains applicable after one application`,
        })
        break
      }
      appliedSameTypeMigrations.add(hop.rule)
    }
    scratch = nextScratch
    for (const linkId of Object.keys(scratch.graphs[graphId]!.links)) {
      if (!linksBefore.has(linkId)) createdLinkIds.add(linkId)
    }
    hops.push(hop)
    diagnostics.push(...hop.diagnostics)
    currentType = hop.plan.to
    seen.add(currentType)
  }
  return {
    graphId,
    nodeId,
    sourceType,
    hops,
    terminalType: currentType,
    status,
    ...(hops.length > 0 ? { rule: hops[0]!.rule, plan: hops[0]!.plan } : {}),
    diagnostics,
    safe: status === 'terminal' && hops.length > 0 && diagnostics.every((entry) => entry.severity === 'info'),
  }
}

/**
 * Find every node a registry rule can migrate and plan its full chain.
 * Subgraph instances ('#...') are never scanned: their schema is derived,
 * not deprecated. Deterministic: graphs and nodes in document iteration
 * order. Chains are planned per node against the ORIGINAL document - nodes
 * are independent (each chain only ever rewrites its own node), so plans
 * from one scan compose in a single batch.
 */
export function scanReplacements(
  document: WorkflowDocument,
  registry: ReplacementRegistry,
  resolve: ReplacementSchemaResolver,
): readonly ReplacementScanItem[] {
  const items: ReplacementScanItem[] = []
  const sourceTypes = registry.sourceTypes()
  for (const [graphId, def] of Object.entries(document.graphs)) {
    for (const node of Object.values(def.nodes)) {
      if (node.type.startsWith('#') || !sourceTypes.has(node.type)) continue
      const item = planChain(document, graphId, node.id, node.type, registry, resolve)
      if (item.hops.length > 0 || item.diagnostics.length > 0 || item.status !== 'terminal') items.push(item)
    }
  }
  return items
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Build the dispatch for a set of scan items: one `node.replace` invocation
 * per planned HOP in chain order, batched when there are several (one
 * revision, one undo step, all-or-nothing - the batch command runs each
 * sub-invocation against the working copy, so hop N's staleness guard sees
 * hop N-1's type change). Batched plans use node-owned net sink updates so
 * independently planned nodes cannot restore one another's stale endpoints.
 * Items without hops are ignored; a blocked item
 * contributes its planned prefix - filter with `safe` upstream to implement
 * "apply without review".
 */
export function replacementInvocation(
  items: readonly ReplacementScanItem[],
): CommandInvocation | undefined {
  const plans = items.flatMap((i) => i.hops.map((h) => h.plan))
  if (plans.length === 0) return undefined
  if (plans.length === 1) return { command: 'node.replace', params: { plan: plans[0]! } as unknown as Json }
  const composablePlans = plans.map((plan) =>
    plan.createdNodes === undefined ? { ...plan, createdNodes: [] } : plan,
  )
  return {
    command: 'batch',
    params: {
      invocations: composablePlans.map((plan) => ({ command: 'node.replace', params: { plan } })),
    } as unknown as Json,
  }
}
