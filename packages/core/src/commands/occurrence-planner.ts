import type { EffectiveLinkIdentity } from '../compile/effective-topology.js'
import { diag, type Diagnostic } from '../diagnostics.js'
import type { OccurrenceLinkEndpoint, WorkflowDocument } from '../format/document.js'
import type { OccurrenceRef } from '../ids.js'
import type { SchemaResolver } from '../schema/derive-boundary.js'
import type { CommandInvocation } from './contract.js'
import { planOccurrenceLinkCommand } from './occurrence-link-commands.js'

export type OccurrenceLinkIntention =
  | {
      readonly kind: 'connect'
      readonly owner: OccurrenceRef
      readonly bodyGraph: string
      readonly from: OccurrenceLinkEndpoint
      readonly to: OccurrenceLinkEndpoint
    }
  | {
      readonly kind: 'disconnect'
      readonly owner: OccurrenceRef
      readonly bodyGraph: string
      readonly link: EffectiveLinkIdentity
    }
  | {
      readonly kind: 'rewire'
      readonly owner: OccurrenceRef
      readonly bodyGraph: string
      readonly link: EffectiveLinkIdentity
      readonly to: OccurrenceLinkEndpoint
    }
  | {
      readonly kind: 'rewireSource'
      readonly owner: OccurrenceRef
      readonly bodyGraph: string
      readonly links: readonly EffectiveLinkIdentity[]
      readonly from: OccurrenceLinkEndpoint
    }

export type OccurrenceLinkPlanResult =
  | { readonly ok: true; readonly invocation: CommandInvocation }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] }

/** Resolve one occurrence-local gesture into an opaque dispatch invocation. */
export function planOccurrenceLinkMutation(
  document: WorkflowDocument,
  resolver: SchemaResolver,
  intention: OccurrenceLinkIntention,
): OccurrenceLinkPlanResult {
  try {
    const planned = planOccurrenceLinkCommand(document, resolver, {
      command: `occurrence.link.${intention.kind}`,
      owner: intention.owner,
      bodyGraph: intention.bodyGraph,
      ...('from' in intention ? { from: intention.from } : {}),
      ...('to' in intention ? { to: intention.to } : {}),
      ...('link' in intention ? { link: intention.link } : {}),
      ...('links' in intention ? { links: intention.links } : {}),
    })
    return planned === undefined
      ? {
          ok: false,
          diagnostics: [diag(
            'error',
            'command',
            'occurrence.link.planUnavailable',
            `occurrence.link.${intention.kind}: endpoint, delivery, or owner topology cannot be resolved`,
          )],
        }
      : { ok: true, invocation: planned.invocation }
  } catch {
    return {
      ok: false,
      diagnostics: [diag(
        'error',
        'command',
        'occurrence.link.planUnavailable',
        `occurrence.link.${intention.kind}: trusted plan could not be constructed`,
      )],
    }
  }
}
