import { readdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

const forbidden = [
  ['app', 'Mount'].join(''),
  ['Extension', 'App', 'Mount'].join(''),
  ['mount', 'Extension', 'Element'].join(''),
  ['create', 'Editor'].join(''),
  ['create', 'Viewer'].join(''),
  ['Extension', 'Shell', 'Slot'].join(''),
  ['register', 'App', 'Mount'].join(''),
  ['extension', 'Mounts'].join(''),
  ['Extension', 'Mount', 'Host'].join(''),
  ['Editor', 'Handle'].join(''),
  ['Edit', 'Session'].join(''),
  ['plain DOM', ' mount/unmount'].join(''),
  ['contract-bound to vanilla DOM', '/web components'].join(''),
  ['Host-owned element', ', selectors'].join(''),
  ['plain DOM', ' mount contract'].join(''),
  ['named app', ' mounts'].join(''),
  ['app ', 'mount'].join(''),
  ['disposable mounted', ' view'].join(''),
  ['host-owned mount', ' containers'].join(''),
  ['framework-neutral mount', ' lifecycle'].join(''),
  ['view owns only its container', ' contents'].join(''),
  ['container contents and returned', '\n  disposer'].join(''),
  ['returned editor', ' disposer'].join(''),
]

const binaryAssetExtensions = new Set(['.ico', '.mp4', '.png', '.webm'])
const fileReadBatchSize = 32

function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === 'release') return []
    const child = join(path, entry.name)
    return entry.isDirectory()
      ? files(child)
      : entry.isFile() && !binaryAssetExtensions.has(extname(entry.name).toLowerCase())
        ? [child]
        : []
  })
}

describe('raw extension UI deletion inventory', () => {
  it('contains none of the retired symbols in source, tests, or docs', async () => {
    const root = join(import.meta.dirname, '../../..')
    const matches = ['packages', 'docs'].flatMap((directory) => files(join(root, directory)))
    const retiredSymbols: string[] = []
    for (let start = 0; start < matches.length; start += fileReadBatchSize) {
      const batch = matches.slice(start, start + fileReadBatchSize)
      const contents = await Promise.all(batch.map(async (path) => [path, await readFile(path, 'utf8')] as const))
      retiredSymbols.push(...contents.flatMap(([path, content]) =>
        forbidden.filter((symbol) => content.includes(symbol)).map((symbol) => `${path}:${symbol}`)))
    }
    expect(retiredSymbols).toEqual([])
  })

  it('allows exactly one scoped client property in the extension widget environment', () => {
    const root = join(import.meta.dirname, '../../..')
    const path = join(root, 'packages/core/src/widgets/contract.ts')
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const widgetEnvs = source.statements.filter((statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === 'WidgetEnv')
    expect(widgetEnvs).toHaveLength(1)
    expect(widgetEnvs[0]!.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)).toBe(true)
    expect(widgetEnvs[0]!.heritageClauses).toBeUndefined()
    const members = [...widgetEnvs[0]!.members]
    expect(members).toHaveLength(1)
    const member = members[0]!
    expect(ts.isPropertySignature(member)).toBe(true)
    if (!ts.isPropertySignature(member)) return
    expect(member.name.getText(source)).toBe('client')
    expect(member.questionToken).toBeUndefined()
    expect(member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword)).toBe(true)
    expect(member.type !== undefined && ts.isTypeReferenceNode(member.type)).toBe(true)
    expect(member.type?.getText(source)).toBe('ScopedClient')
  })
})
