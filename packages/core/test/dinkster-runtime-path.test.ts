import { describe, expect, it } from 'vitest'
import { dinksterRuntimePathRoot, parseDinksterRuntimePath } from '../src/events/dinkster.js'

// Closed grammar from Dinkster DESIGN 3.13 (backend commit 95106fd):
//   path    = segment ("/" segment)*
//   segment = nodeId | nodeId "[" decimal-index "]"
// Node ids can never contain '/', '[' or ']' (banned at wire decode and
// validation), so parsing is mechanical.

describe('parseDinksterRuntimePath', () => {
  it('parses plain node ids', () => {
    expect(parseDinksterRuntimePath('node')).toEqual([{ nodeId: 'node' }])
    // Our flattened occurrence keys are single backend segments.
    expect(parseDinksterRuntimePath('n0.n0')).toEqual([{ nodeId: 'n0.n0' }])
  })

  it('parses diagnostic paths without iteration suffixes', () => {
    expect(parseDinksterRuntimePath('r/add')).toEqual([{ nodeId: 'r' }, { nodeId: 'add' }])
  })

  it('parses nested iteration paths', () => {
    expect(parseDinksterRuntimePath('outer[0]/inner[2]/node')).toEqual([
      { nodeId: 'outer', iteration: 0 },
      { nodeId: 'inner', iteration: 2 },
      { nodeId: 'node' },
    ])
    expect(parseDinksterRuntimePath('r[3]/node')).toEqual([
      { nodeId: 'r', iteration: 3 },
      { nodeId: 'node' },
    ])
  })

  it('allows ids with spaces and unicode (only /[] are banned backend-side)', () => {
    expect(parseDinksterRuntimePath('my node[1]/x y')).toEqual([
      { nodeId: 'my node', iteration: 1 },
      { nodeId: 'x y' },
    ])
  })

  it('rejects everything outside the closed grammar', () => {
    for (const bad of [
      '', // empty path
      '/', // empty segments
      'a//b', // empty middle segment
      'a/', // empty trailing segment
      'r[3]x', // trailing junk after ']'
      'r[3', // unterminated index
      'r]3[', // brackets out of order
      'r[]', // empty index
      'r[+3]', // signed index
      'r[-1]', // negative index
      'r[03]', // leading zero (not plain decimal)
      'r[3.5]', // non-integer
      'r[ 3]', // whitespace in index
      'a[1][2]', // double suffix
    ]) {
      expect(parseDinksterRuntimePath(bad), bad).toBeUndefined()
    }
  })
})

describe('dinksterRuntimePathRoot', () => {
  it('returns the submitted top-level node id', () => {
    expect(dinksterRuntimePathRoot('n1')).toBe('n1')
    expect(dinksterRuntimePathRoot('r[3]/add')).toBe('r')
    expect(dinksterRuntimePathRoot('outer[0]/inner[2]/node')).toBe('outer')
  })

  it('is undefined for malformed paths', () => {
    expect(dinksterRuntimePathRoot('')).toBeUndefined()
    expect(dinksterRuntimePathRoot('a//b')).toBeUndefined()
  })
})
