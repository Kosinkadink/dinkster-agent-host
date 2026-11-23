import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const expectedTrees = new Map([
  ['packages/agent-host', '49f3b6f8db8fbb283fb48a32a8fed256488ab1450dcf05a06dee7d5254c8a503'],
  ['packages/client', 'afaab95647ebb29e00f0328224611c0e96a7efbf8c84f2a374c6e530e92b7016'],
  ['packages/core', '9a84590b7764e7e3a637ed8024c08d033e63761dc07df78bbc2695cc188e023c'],
])

for (const [directory, expected] of expectedTrees) {
  const files = execFileSync('git', ['ls-files', directory], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean)
    .sort()
  const manifest = files
    .map((file) => `${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${file}\n`)
    .join('')
  const actual = createHash('sha256').update(manifest).digest('hex')
  if (actual !== expected) {
    throw new Error(`${directory} tree digest ${actual} does not match pinned digest ${expected}`)
  }
  console.log(`${directory}: ${actual}`)
}
