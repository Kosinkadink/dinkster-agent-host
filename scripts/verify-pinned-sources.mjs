import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const expectedTrees = new Map([
  ['packages/agent-host', 'c8960b3e917471f0ae32f72cbd173c4d9a69a43938ff99e7bb91a1f863343a76'],
  ['packages/client', '996d6e0622550c8e897788d10b946e4a2e36a38a1469b65c887aada8af088700'],
  ['packages/core', '0ee22ab556623c0b73a8331b9c2be05778f6a1ca552c8211f8d32f94ddf312b1'],
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
