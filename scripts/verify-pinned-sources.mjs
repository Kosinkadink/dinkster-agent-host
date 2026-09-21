import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const expectedTrees = new Map([
  ['packages/agent-host', 'b57270de9289c4155a4bed16d1758e964eda35bce754e32872deea44681276e4'],
  ['packages/client', '813a2cae9c2836612f6b67bb1a7fa391ed2d302b48dc835a16a2a5d24ea885fb'],
  ['packages/core', '9ca9c7680cae0cc8bfe3b4054cdb63d5eb2eed3ed5547a0357b7a9b9eb966775'],
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
