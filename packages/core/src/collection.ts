/**
 * Collection contract: ONE display vocabulary and ONE paging discipline
 * for every browsable collection - installed packs, execution history,
 * templates, assets, and whatever extensions contribute.
 *
 * The old ecosystem's lesson, baked in as contract:
 * - the QUERY belongs to the SOURCE. A source ranks/filters its whole
 *   corpus (in memory for local sources, server-side for remote ones) and
 *   returns pages of the RESULT; a view never filters a loaded page,
 *   which is how "search only finds what happened to be loaded" bugs are
 *   born;
 * - cursors are query-bound: a cursor is only valid for the query that
 *   produced it, so a query change always restarts paging;
 * - entries are presentation data with an OPTIONAL thumbnail. Not
 *   everything has a useful image (models, packs), so text-first layouts
 *   must be first-class - hosts derive initials when thumbUrl is absent,
 *   and never force a thumbnail-dominant card on thumbless entries.
 */

import { rankSearch, type SearchField } from './search.js'

/** One entry in a browsable collection, in the common display vocabulary. */
export interface CollectionEntry {
  /** Stable id within the source (pack id, execution key, template id). */
  readonly id: string
  readonly title: string
  readonly subtitle?: string
  /** Small status/type chips ('running', 'registry', '24 nodes'). */
  readonly badges?: readonly string[]
  /**
   * Lazy thumbnail URL (browser-cache friendly - digest/ETag-backed
   * endpoints preferred). Absent = text-only entry; the host renders a
   * derived-initials block, never a broken-image placeholder.
   */
  readonly thumbUrl?: string
  /**
   * Lazy thumbnail RENDER for entries whose bytes are not directly
   * displayable (a GLB needs a 3D render before it has pixels). Resolves
   * to a displayable URL (typically a cached object URL); a rejection
   * falls back to the text-first presentation. thumbUrl wins when both
   * are present.
   */
  readonly thumbRender?: () => Promise<string>
  /** Label/text pairs for the details rail; order is display order. */
  readonly details?: readonly { readonly label: string; readonly text: string }[]
  /**
   * Presentation-only children hidden behind an expandable parent row.
   * Children remain ordinary entries, so their details and actions retain
   * their own identities. A stable parent id lets expansion survive live
   * source refreshes where the source's paging window retains its anchor.
   */
  readonly children?: readonly CollectionEntry[]
  /**
   * Optional per-entry operations (delete a run, ...). Hosts render them
   * on the SELECTED entry only and route clicks to their action handler;
   * an action click never doubles as activation.
   */
  readonly actions?: readonly { readonly id: string; readonly label: string }[]
  /**
   * Identity of the backend/service instance that SERVED this entry
   * (remote sources set it; local sources omit it). Activation and entry
   * actions must route back to this owner - never to whatever backend is
   * current when the click lands - so an entry id can never be resolved,
   * opened, or deleted against a different backend's namespace.
   */
  readonly owner?: string
  /**
   * Marks a NAVIGATION row: activating it browses into `path` (the source
   * receives it as CollectionPageRequest.folder) instead of selecting or
   * picking. Folder rows are never pickable and carry no ref.
   */
  readonly folder?: { readonly path: string }
  /**
   * Adapter-owned value a HOST needs to act on this entry (commit an
   * AssetRef, ...). Opaque to the collection vocabulary: the source that
   * minted the entry and the host that consumes it share its real type;
   * the surface between them only carries it.
   */
  readonly ref?: unknown
}

export interface CollectionPage {
  readonly items: readonly CollectionEntry[]
  /** Opaque cursor for the NEXT page; absent = exhausted. */
  readonly cursor?: string
  /** Total matches for the query, when the source knows it cheaply. */
  readonly total?: number
  /**
   * Identity of the backend/service instance that SERVED this page (remote
   * sources set it, even on empty pages; local sources omit it). Hosts use
   * it to scope PAGE-level operations (bulk clear, ...) to the corpus the
   * user is actually looking at: while a replacement page is in flight the
   * previously committed page may stay visible, so "whatever backend is
   * current" and "the backend whose entries are on screen" can differ.
   */
  readonly owner?: string
}

export interface CollectionPageRequest {
  /** The search query; '' = unfiltered browse in the source's own order. */
  readonly query: string
  /**
   * A cursor previously returned by this source FOR THE SAME QUERY.
   * Sources treat a cursor from another query as absent (restart at the
   * first page) rather than serving wrong-query leftovers.
   */
  readonly cursor?: string
  readonly limit: number
  /** Source-specific exact-match filters supplied by the shared browser. */
  readonly filters?: Readonly<Record<string, string>>
  /**
   * Folder scope for folder-capable sources ('' or absent = root). Only
   * sent when the source declares `folders`; a changed folder restarts
   * paging exactly like a changed query.
   */
  readonly folder?: string
  /**
   * Cancellation for the request. The shared browser aborts superseded
   * requests; sources SHOULD honor it (pass it to fetch) but a source
   * that ignores it is still correct - the browser's generation guard
   * drops stale results regardless.
   */
  readonly signal?: AbortSignal
}

/** A paged, query-owning provider of collection entries. */
export interface CollectionSource {
  /** Stable source id ('packs', 'history', 'kj.templates'). */
  readonly id: string
  /** Tab label in collection UIs. */
  readonly label: string
  /**
   * Declares folder navigation: the browser renders a breadcrumb, sends
   * CollectionPageRequest.folder, and treats entry.folder rows as
   * navigation. The SOURCE owns folder-row inclusion (it prepends folder
   * entries to its own pages when appropriate) - there is no separate
   * folder-listing call.
   */
  readonly folders?: boolean
  /** Optional exact-match filters rendered by collection UIs. */
  readonly filters?: readonly { readonly id: string; readonly label: string; options(): readonly { readonly value: string; readonly label: string }[] }[]
  page(req: CollectionPageRequest): Promise<CollectionPage>
}

/** Default weighted fields: title dominates, subtitle and badges assist. */
export const defaultEntryFields = (e: CollectionEntry): SearchField[] => [
  { text: e.title, weight: 3 },
  ...(e.subtitle !== undefined ? [{ text: e.subtitle, weight: 2 }] : []),
  ...(e.badges ?? []).map((b) => ({ text: b, weight: 1 })),
]

/** Query-bound local cursor: offset + the query that produced it. */
interface LocalCursor {
  readonly q: string
  readonly offset: number
}

const decodeCursor = (cursor: string | undefined, query: string): number => {
  if (cursor === undefined) return 0
  try {
    const parsed = JSON.parse(cursor) as Partial<LocalCursor>
    // Wrong-query cursors restart at the first page by contract.
    if (parsed.q !== query || typeof parsed.offset !== 'number' || parsed.offset < 0) return 0
    return Math.floor(parsed.offset)
  } catch {
    return 0
  }
}

/**
 * Build a CollectionSource over an in-memory corpus, ranked through the
 * shared scorer so a query behaves identically to every other search box.
 * `corpus` is re-read on every page call - local sources are LIVE (packs
 * change on reconnect, history grows), and a fresh snapshot per request
 * beats a stale index. Ranking the full corpus per call is fine at local
 * scale; remote sources implement CollectionSource directly instead.
 */
export function localCollectionSource(args: {
  readonly id: string
  readonly label: string
  readonly corpus: () => readonly CollectionEntry[]
  /** Weighted searchable fields; defaults to title/subtitle/badges. */
  readonly fieldsOf?: (e: CollectionEntry) => readonly SearchField[]
}): CollectionSource {
  const fieldsOf = args.fieldsOf ?? defaultEntryFields
  return {
    id: args.id,
    label: args.label,
    page: (req) => {
      const matches = rankSearch(req.query, args.corpus(), fieldsOf)
      const offset = decodeCursor(req.cursor, req.query)
      const items = matches.slice(offset, offset + req.limit)
      const next = offset + items.length
      return Promise.resolve({
        items,
        total: matches.length,
        ...(next < matches.length
          ? { cursor: JSON.stringify({ q: req.query, offset: next } satisfies LocalCursor) }
          : {}),
      })
    },
  }
}
