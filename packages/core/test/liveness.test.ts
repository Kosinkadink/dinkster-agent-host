import { describe, expect, it } from 'vitest'
import { LivenessDerivation, traverseRoutedProjection, type RoutedNode, type RoutedStep, type WouldRunEdges } from '../src/compile/liveness.js'

describe('routed liveness projection', () => {
  it('uses one recursive engine while would-run unions nested branches', () => {
    const route = (at: string, projection: 'exact' | 'would-run') => ({
      hop: at,
      steps: at === 'outer' ? [{ kind: 'recurse' as const, at: 'inner' }] : projection === 'exact'
        ? [{ kind: 'terminal' as const, terminal: 'rolled' }]
        : [
            { kind: 'terminal', terminal: 'candidate-a' },
            { kind: 'recurse', at: 'leaf' },
          ] as readonly RoutedStep<string, string>[],
    })
    const adapter = {
      key: (at: string) => at,
      route,
    }

    expect(traverseRoutedProjection('outer', 'exact', adapter).terminals).toEqual(['rolled'])
    expect(traverseRoutedProjection('outer', 'would-run', adapter).terminals).toEqual([
      'candidate-a',
      'candidate-a',
    ])
  })

  it('derives nested inactive-exclusive cones while preserving shared and other-root producers', () => {
    const edge = (producer: string) => [producer, 0] as const
    const nodes = new Map<string, RoutedNode>([
      ['outer', { inputs: { off: edge('outerOff'), on: edge('inner'), shared: edge('shared') }, selectorProjection: { choice: true, branches: { false: 'off', true: 'on' } } }],
      ['inner', { inputs: { off: edge('innerOn'), on: edge('innerOff') }, selectorProjection: { choice: false, branches: { false: 'off', true: 'on' } } }],
      ['otherRoot', { inputs: { input: edge('otherUsed') } }],
      ['outerOff', { inputs: { shared: edge('shared'), elsewhere: edge('otherUsed'), exclusive: edge('outerOnly') } }],
      ['innerOn', { inputs: { shared: edge('shared') } }],
      ['innerOff', { inputs: { input: edge('innerOnly') } }],
      ['shared', { inputs: {} }],
      ['otherUsed', { inputs: {} }],
      ['outerOnly', { inputs: {} }],
      ['innerOnly', { inputs: {} }],
    ])
    // Presence of the projection map selects would-run behavior; these edges
    // also model routed bypass/reroute/tap/net successors per destination.
    const routed: WouldRunEdges = new Map()
    const result = new LivenessDerivation().derive(nodes, ['outer', 'otherRoot'], routed)

    expect([...result.included].sort()).toEqual(['inner', 'innerOn', 'otherRoot', 'otherUsed', 'outer', 'shared'])
    expect([...result.inactiveExclusive.get('outer') ?? []].sort()).toEqual(['outerOff', 'outerOnly'])
    expect([...result.inactiveExclusive.get('inner') ?? []].sort()).toEqual(['innerOff', 'innerOnly'])
  })

  it('keeps missing and non-boolean selector choices neutral by omitting a projection', () => {
    const nodes = new Map<string, RoutedNode>([
      ['selector', { inputs: { off: ['falseSource', 0], on: ['trueSource', 0] } }],
      ['falseSource', { inputs: {} }],
      ['trueSource', { inputs: {} }],
    ])
    const result = new LivenessDerivation().derive(nodes, ['selector'], new Map())
    expect([...result.included].sort()).toEqual(['falseSource', 'selector', 'trueSource'])
    expect(result.inactiveExclusive.size).toBe(0)
  })
})
