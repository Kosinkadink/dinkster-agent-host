import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(resolve(import.meta.dirname, '../../../.github/workflows/ci.yml'), 'utf8')

describe('CI workflow', () => {
  it('uses the bounded public Linux runner contract', () => {
    const jobs = workflow.split('\njobs:\n', 2)[1]

    expect(jobs).toBeDefined()
    expect(jobs).toContain('runs-on: ubuntu-latest')
    expect(jobs).toContain('timeout-minutes: 5')
    expect(workflow).toContain('permissions:\n  contents: read')
    expect(workflow).toContain('persist-credentials: false')
    expect(workflow.toLowerCase()).not.toContain('self-hosted')
    expect(workflow.toLowerCase()).not.toContain('gpu')
  })
})
