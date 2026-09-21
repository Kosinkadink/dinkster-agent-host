/**
 * View-occurrence mapping: which runtime node ids belong to which scene
 * node of the graph definition currently on screen.
 *
 * Runtime ids are occurrence keys (ids.ts: escaped instance-path segments
 * joined by '.'), optionally wrapped in the backend's region-iteration path
 * grammar ('outer[0]/inner[2]/node' - '/', '[' and ']' are backend-reserved
 * and can never appear inside a flattened id). Given the instance path the
 * user actually navigated (root = []), every runtime id classifies as:
 *
 * - OWN: its occurrence's instance path equals the view path - the runtime
 *   identity of a node DEFINED in the viewed graph. Undecorated exact ids
 *   sort first; iteration-decorated variants of the same node follow.
 * - INNER: the view path is a proper prefix - the id lives beneath one of
 *   the viewed graph's subgraph-instance nodes (keyed by that instance).
 * - neither: a different branch of the instance tree; ignored.
 *
 * A def instantiated more than once is disambiguated by construction: the
 * navigated path names ONE instance chain, so a sibling instance's ids
 * never leak into the view. When compile provenance is available its
 * toSource map is authoritative (a source node may lower under a different
 * runtime name); parsing is the fallback for artifact-less executions.
 *
 * Pure derivation; callers that cannot produce a trustworthy instance path
 * (desynced navigation state) must abstain rather than guess.
 */

import { parseOccurrenceKey, type Occurrence } from './ids.js'

export interface ViewOccurrences {
  /** Scene node id -> runtime ids of that node's own occurrence (exact-first). */
  readonly own: ReadonlyMap<string, readonly string[]>
  /** Subgraph-instance scene node id -> runtime ids nested beneath it. */
  readonly inner: ReadonlyMap<string, readonly string[]>
}

const EMPTY: readonly string[] = []

/** Runtime ids relevant to one scene node (own occurrence + nested). */
export function runtimeIdsFor(occ: ViewOccurrences, sceneNodeId: string): readonly string[] {
  const own = occ.own.get(sceneNodeId)
  const inner = occ.inner.get(sceneNodeId)
  if (own && inner) return [...own, ...inner]
  return own ?? inner ?? EMPTY
}

const ITERATION_SUFFIX = /\[\d+\]$/

/**
 * Parse a runtime id's document identity: the occurrence key is the FIRST
 * backend path segment with any iteration suffix stripped; anything beyond
 * (more segments, or a stripped suffix) marks the id as decorated - an
 * iteration/inner variant rather than the plain occurrence itself.
 */
export function documentIdentityOf(
  runtimeId: string,
  toSource: Readonly<Record<string, string>> | undefined,
): { readonly occurrence: Occurrence; readonly decorated: boolean } | undefined {
  const segs = runtimeId.split('/')
  const first = segs[0]!
  const stripped = first.replace(ITERATION_SUFFIX, '')
  if (stripped.length === 0) return undefined
  const key = toSource?.[runtimeId] ?? toSource?.[stripped] ?? stripped
  const decorated = segs.length > 1 || stripped !== first
  try {
    return { occurrence: parseOccurrenceKey(key), decorated }
  } catch {
    return undefined
  }
}

/**
 * Classify every runtime id against the viewed graph's navigated instance
 * path. `toSource` (compile provenance, runtime id -> occurrence key) is
 * consulted first when present; ids it does not know fall back to parsing.
 */
export function occurrencesForView(args: {
  /** Instance node ids navigated from the root to the viewed def ([] = root). */
  readonly instancePath: readonly string[]
  readonly runtimeIds: Iterable<string>
  /** Compile provenance (artifact.provenance.toSource) when available. */
  readonly toSource?: Readonly<Record<string, string>> | undefined
}): ViewOccurrences {
  return occurrencesForViews({
    instancePaths: [args.instancePath],
    runtimeIds: args.runtimeIds,
    toSource: args.toSource,
  })[0] ?? { own: new Map(), inner: new Map() }
}

interface ViewPathTrie {
  readonly terminals: number[]
  readonly children: Map<string, ViewPathTrie>
}

/**
 * Classify runtime ids against multiple graph occurrences in one pass.
 * Shared definitions can have many instance paths, so the path trie avoids
 * reparsing every runtime identity once per occurrence.
 */
export function occurrencesForViews(args: {
  readonly instancePaths: readonly (readonly string[])[]
  readonly runtimeIds: Iterable<string>
  readonly toSource?: Readonly<Record<string, string>> | undefined
}): readonly ViewOccurrences[] {
  const root: ViewPathTrie = { terminals: [], children: new Map() }
  const views = args.instancePaths.map(() => ({
    own: new Map<string, string[]>(),
    inner: new Map<string, string[]>(),
  }))
  for (const [index, path] of args.instancePaths.entries()) {
    let cursor = root
    for (const segment of path) {
      let child = cursor.children.get(segment)
      if (child === undefined) {
        child = { terminals: [], children: new Map() }
        cursor.children.set(segment, child)
      }
      cursor = child
    }
    cursor.terminals.push(index)
  }
  for (const runtimeId of args.runtimeIds) {
    const identity = documentIdentityOf(runtimeId, args.toSource)
    if (!identity) continue
    const path = identity.occurrence.instancePath
    const classify = (viewIndex: number, viewDepth: number): void => {
      const view = views[viewIndex]!
      if (path.length === viewDepth) {
        const list = view.own.get(identity.occurrence.node) ?? []
        // Exact (undecorated) identity first; iteration variants after.
        if (identity.decorated) list.push(runtimeId)
        else list.unshift(runtimeId)
        view.own.set(identity.occurrence.node, list)
      } else {
        const instance = path[viewDepth]!
        const list = view.inner.get(instance) ?? []
        list.push(runtimeId)
        view.inner.set(instance, list)
      }
    }
    let cursor = root
    for (const viewIndex of cursor.terminals) classify(viewIndex, 0)
    for (let depth = 0; depth < path.length; depth++) {
      const child = cursor.children.get(path[depth]!)
      if (child === undefined) break
      cursor = child
      for (const viewIndex of cursor.terminals) classify(viewIndex, depth + 1)
    }
  }
  return views
}
