/**
 * Deterministic synthetic-workload generator for benchmarks and stress tests
 * (the "1k+ nodes, heavy noodles" performance budget from the architecture).
 *
 * Emits plain document-format-v1 JSON (same shape as the golden fixtures) so
 * every consumer - compile benchmarks, scene-build budgets, in-browser
 * frame-time specs - goes through the real loadDocument path. Uses only core
 * ComfyUI node types (EmptyImage, ImageScaleBy, PreviewImage) so the same
 * document also compiles against a live backend.
 *
 * Feature flags layer first-class constructs onto the same base topology so
 * their render/compile cost can be measured in isolation (bench/feature-cost):
 * each flag adds a fixed, documented amount of extra structure per chain.
 */

export interface SyntheticWorkflowOptions {
  /** Number of independent EmptyImage -> scale... -> PreviewImage chains. */
  readonly chains: number
  /** Nodes per chain, minimum 2 (source + preview). */
  readonly chainLength: number
  /**
   * Route every chain link through a reroute junction placed at the segment
   * midpoint (doubles the drawn segments and exercises reroute tracing).
   */
  readonly reroutes?: boolean
  /**
   * One value source per chain, fanning out to the EmptyImage's width AND
   * height (2 links each; exercises spec derivation + source rendering).
   */
  readonly valueSources?: boolean
  /**
   * Replace each chain's final link (into PreviewImage) with a named net
   * (exercises net tracing + fan-out noodle rendering). Wins over `reroutes`
   * for that segment.
   */
  readonly nets?: boolean
  /** One group rectangle per chain, bounding its whole row. */
  readonly groups?: boolean
  /**
   * Insert a selector at each chain's midpoint segment: two candidates, the
   * true upstream (fixed policy) plus a decoy branch driven by the chain
   * source (same IMAGE type, so solving stays clean). Replaces 1 link with
   * 3 (two candidate feeds + the output). Wins over `reroutes` for that
   * segment; skipped if `nets` already claimed it (chainLength 2).
   */
  readonly selectors?: boolean
  /**
   * Replace the inline chains with subgraph instances: ONE shared definition
   * holds the chain body (EmptyImage -> scales, with a promoted `color`
   * input and an `image` output), and the root graph holds `chains`
   * instances each feeding its own PreviewImage. Root-visible nodes drop to
   * 2 * chains while expanded execution occurrences stay chains *
   * chainLength. Replaces the base topology, so it cannot be combined with
   * the other feature flags.
   */
  readonly subgraphs?: boolean
  /**
   * With `subgraphs`: wrap the chain-body definition in this many nested
   * pass-through definitions (each re-exports the inner boundary through an
   * instance node). Depth 1 (default) means instances use the body
   * directly. Adds no executable nodes; exercises nested flattening.
   */
  readonly subgraphDepth?: number
}

const GRID = { x0: 80, y0: 80, colX: 320, rowY: 260 }

/** Total node count is chains * chainLength; links are nodes - chains. */
export function syntheticWorkflow(options: SyntheticWorkflowOptions): unknown {
  const { chains, chainLength } = options
  if (chains < 1 || chainLength < 2) throw new Error('need chains >= 1 and chainLength >= 2')
  if (options.subgraphs) return syntheticSubgraphWorkflow(options)
  if (options.subgraphDepth !== undefined) throw new Error('subgraphDepth requires subgraphs')

  const nodes: Record<string, unknown> = {}
  const links: Record<string, unknown> = {}
  const reroutes: Record<string, unknown> = {}
  const nets: Record<string, unknown> = {}
  const valueSources: Record<string, unknown> = {}
  const selectors: Record<string, unknown> = {}
  const viewNodes: Record<string, unknown> = {}
  const viewReroutes: Record<string, unknown> = {}
  const viewValueSources: Record<string, unknown> = {}
  const viewSelectors: Record<string, unknown> = {}
  const viewGroups: Record<string, unknown> = {}
  let ordinal = 0

  const { colX, rowY } = GRID
  const selectorSegment = Math.max(1, Math.floor(chainLength / 2))

  for (let c = 0; c < chains; c++) {
    let prev: string | undefined
    let first: string | undefined
    for (let i = 0; i < chainLength; i++) {
      const id = `n${ordinal++}`
      if (i === 0) {
        first = id
        nodes[id] = {
          id,
          type: 'EmptyImage',
          values: { width: 64, height: 64, batch_size: 1, color: (c * 7919) % 0xffffff },
        }
      } else if (i === chainLength - 1) {
        nodes[id] = { id, type: 'PreviewImage', values: {} }
      } else {
        nodes[id] = {
          id,
          type: 'ImageScaleBy',
          values: { upscale_method: 'nearest-exact', scale_by: 1.0 },
        }
      }
      if (prev !== undefined) {
        const last = i === chainLength - 1
        const toPort = last ? 'images' : 'image'
        if (options.nets && last) {
          // The final segment rides a named net instead of a link.
          const netId = `net${ordinal++}`
          nets[netId] = {
            id: netId,
            name: `IMG_${c}`,
            source: { node: prev, port: 'out0' },
            sinks: [{ node: id, port: toPort }],
          }
        } else if (options.selectors && i === selectorSegment) {
          // True upstream on candidate 'ca' (fixed policy), decoy branch from
          // the chain source on 'cb'. Both are IMAGE producers, so editing-
          // time solving (which checks EVERY candidate) stays conflict-free.
          const selectorId = `s${ordinal++}`
          selectors[selectorId] = {
            id: selectorId,
            candidates: [{ id: 'ca' }, { id: 'cb' }],
            policy: { kind: 'fixed', candidate: 'ca' },
          }
          viewSelectors[selectorId] = {
            position: { x: 80 + (i - 0.5) * colX, y: 80 + c * rowY + 40 },
          }
          const feedA = `l${ordinal++}`
          links[feedA] = { id: feedA, from: { node: prev, port: 'out0' }, to: { selector: selectorId, candidate: 'ca' } }
          const feedB = `l${ordinal++}`
          links[feedB] = { id: feedB, from: { node: first, port: 'out0' }, to: { selector: selectorId, candidate: 'cb' } }
          const outId = `l${ordinal++}`
          links[outId] = { id: outId, from: { selector: selectorId }, to: { node: id, port: toPort } }
        } else if (options.reroutes) {
          const rerouteId = `r${ordinal++}`
          reroutes[rerouteId] = { id: rerouteId }
          viewReroutes[rerouteId] = {
            position: { x: 80 + (i - 0.5) * colX, y: 80 + c * rowY + 40 },
          }
          const feedId = `l${ordinal++}`
          links[feedId] = { id: feedId, from: { node: prev, port: 'out0' }, to: { reroute: rerouteId } }
          const outId = `l${ordinal++}`
          links[outId] = { id: outId, from: { reroute: rerouteId }, to: { node: id, port: toPort } }
        } else {
          const linkId = `l${ordinal++}`
          links[linkId] = {
            id: linkId,
            from: { node: prev, port: 'out0' },
            to: { node: id, port: toPort },
          }
        }
      }
      viewNodes[id] = { position: { x: 80 + i * colX, y: 80 + c * rowY } }
      prev = id
    }

    if (options.valueSources && first !== undefined) {
      // One literal producer per chain, fanning out to width AND height (both
      // INT: the effective spec derives cleanly, no conflicts).
      const vsId = `v${ordinal++}`
      valueSources[vsId] = { id: vsId, value: 64 + (c % 8) * 16 }
      viewValueSources[vsId] = { position: { x: -180, y: 80 + c * rowY + 20 } }
      for (const port of ['width', 'height']) {
        const linkId = `l${ordinal++}`
        links[linkId] = { id: linkId, from: { valueSource: vsId }, to: { node: first, port } }
      }
    }

    if (options.groups) {
      const groupId = `grp${ordinal++}`
      viewGroups[groupId] = {
        id: groupId,
        title: `Chain ${c}`,
        bounds: { x: 40, y: 80 + c * rowY - 50, width: (chainLength - 1) * colX + 320, height: rowY - 40 },
      }
    }
  }

  const flags = [
    options.reroutes ? 'reroutes' : '',
    options.valueSources ? 'valueSources' : '',
    options.nets ? 'nets' : '',
    options.groups ? 'groups' : '',
    options.selectors ? 'selectors' : '',
  ].filter(Boolean)
  const suffix = flags.length > 0 ? `-${flags.join('-')}` : ''

  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: `synthetic-${chains}x${chainLength}${suffix}`,
    root: 'g0',
    graphs: {
      g0: {
        id: 'g0',
        name: 'root',
        nodes,
        links,
        nets,
        reroutes,
        ...(options.valueSources ? { valueSources } : {}),
        ...(options.selectors ? { selectors } : {}),
        nextOrdinal: ordinal,
      },
    },
    view: {
      graphs: {
        g0: {
          nodes: viewNodes,
          ...(options.reroutes ? { reroutes: viewReroutes } : {}),
          ...(options.valueSources ? { valueSources: viewValueSources } : {}),
          ...(options.selectors ? { selectors: viewSelectors } : {}),
          ...(options.groups ? { groups: viewGroups } : {}),
        },
      },
    },
    meta: { title: `Synthetic ${chains}x${chainLength} (${chains * chainLength} nodes)${suffix}` },
  }
}

/**
 * Subgraph variant of the synthetic workload. One shared chain-body
 * definition (chainLength - 1 nodes: EmptyImage -> scales) with a promoted
 * `color` input and an `image` output; `chains` instances in the root, each
 * feeding a PreviewImage. Optional pass-through wrapper definitions nest the
 * body `subgraphDepth` levels deep without adding executable nodes - each
 * wrapper's boundary binds straight onto its inner instance's boundary
 * ports, which is exactly the "anything that works on a node works on a
 * subgraph" contract.
 *
 * Root-visible nodes: 2 * chains. Expanded execution occurrences:
 * chains * chainLength (chains * (chainLength - 1) body nodes + chains
 * previews). Graph definitions: subgraphDepth. Instances: chains + a single
 * wrapper instance per nesting level.
 */
function syntheticSubgraphWorkflow(options: SyntheticWorkflowOptions): unknown {
  const { chains, chainLength } = options
  const depth = options.subgraphDepth ?? 1
  if (depth < 1) throw new Error('need subgraphDepth >= 1')
  if (options.reroutes || options.valueSources || options.nets || options.groups)
    throw new Error('subgraphs replaces the base topology; do not combine with other flags')

  const graphs: Record<string, unknown> = {}
  const viewGraphs: Record<string, unknown> = {}

  // g1: the chain body definition, shared by every instance.
  const bodyNodes: Record<string, unknown> = {}
  const bodyLinks: Record<string, unknown> = {}
  const bodyView: Record<string, unknown> = {}
  let ord = 0
  let last = ''
  const bodyCount = chainLength - 1
  for (let i = 0; i < bodyCount; i++) {
    const id = `n${ord++}`
    bodyNodes[id] =
      i === 0
        ? { id, type: 'EmptyImage', values: { width: 64, height: 64, batch_size: 1, color: 0 } }
        : { id, type: 'ImageScaleBy', values: { upscale_method: 'nearest-exact', scale_by: 1.0 } }
    if (i > 0) {
      const linkId = `l${ord++}`
      bodyLinks[linkId] = { id: linkId, from: { node: last, port: 'out0' }, to: { node: id, port: 'image' } }
    }
    bodyView[id] = { position: { x: GRID.x0 + i * GRID.colX, y: 100 } }
    last = id
  }
  graphs['g1'] = {
    id: 'g1',
    name: 'Chain body',
    nodes: bodyNodes,
    links: bodyLinks,
    nets: {},
    reroutes: {},
    boundary: {
      inputs: [{ id: 'color', binds: { kind: 'port', node: 'n0', port: 'color' }, promoted: true }],
      outputs: [{ id: 'image', binds: { kind: 'port', node: last, port: 'out0' } }],
    },
    nextOrdinal: ord,
  }
  viewGraphs['g1'] = { nodes: bodyView }

  // g2..g{depth}: pass-through wrappers re-exporting the inner boundary.
  let innermost = 'g1'
  for (let d = 2; d <= depth; d++) {
    const gid = `g${d}`
    graphs[gid] = {
      id: gid,
      name: `Wrapper ${d - 1}`,
      nodes: { n0: { id: 'n0', type: `#${innermost}`, values: {} } },
      links: {},
      nets: {},
      reroutes: {},
      boundary: {
        inputs: [{ id: 'color', binds: { kind: 'port', node: 'n0', port: 'color' }, promoted: true }],
        outputs: [{ id: 'image', binds: { kind: 'port', node: 'n0', port: 'image' } }],
      },
      nextOrdinal: 1,
    }
    viewGraphs[gid] = { nodes: { n0: { position: { x: 100, y: 100 } } } }
    innermost = gid
  }

  // Root: one instance + preview pair per chain, distinct promoted colors.
  const rootNodes: Record<string, unknown> = {}
  const rootLinks: Record<string, unknown> = {}
  const rootView: Record<string, unknown> = {}
  let rootOrd = 0
  for (let c = 0; c < chains; c++) {
    const inst = `n${rootOrd++}`
    rootNodes[inst] = { id: inst, type: `#${innermost}`, values: { color: (c * 7919) % 0xffffff } }
    rootView[inst] = { position: { x: GRID.x0, y: GRID.y0 + c * GRID.rowY } }
    const preview = `n${rootOrd++}`
    rootNodes[preview] = { id: preview, type: 'PreviewImage', values: {} }
    rootView[preview] = { position: { x: GRID.x0 + GRID.colX, y: GRID.y0 + c * GRID.rowY } }
    const linkId = `l${rootOrd++}`
    rootLinks[linkId] = { id: linkId, from: { node: inst, port: 'image' }, to: { node: preview, port: 'images' } }
  }
  graphs['g0'] = {
    id: 'g0',
    name: 'root',
    nodes: rootNodes,
    links: rootLinks,
    nets: {},
    reroutes: {},
    nextOrdinal: rootOrd,
  }
  viewGraphs['g0'] = { nodes: rootView }

  const depthSuffix = depth > 1 ? `-d${depth}` : ''
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: `synthetic-${chains}x${chainLength}-subgraphs${depthSuffix}`,
    root: 'g0',
    graphs,
    view: { graphs: viewGraphs },
    meta: {
      title:
        `Synthetic ${chains}x${chainLength} subgraphs${depthSuffix} ` +
        `(${chains} instances, ${chains * chainLength} expanded nodes)`,
    },
  }
}
