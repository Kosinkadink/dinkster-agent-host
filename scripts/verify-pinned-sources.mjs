import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const expectedTrees = new Map([
  ['packages/agent-host', '49f3b6f8db8fbb283fb48a32a8fed256488ab1450dcf05a06dee7d5254c8a503'],
  ['packages/client', '4ddd62f9ecdfcd340b7ae3d3b50c2eb92bcc1c994fded6d0b3150dfaeb35d4a7'],
  ['packages/core', 'f11ce54ab783523d11a0bebd3767159c60bd29d4f294b46ca363029fe4dffc30'],
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
