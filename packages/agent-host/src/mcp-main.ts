#!/usr/bin/env -S tsx
import { credentialFetch } from '@dinkster/client'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createAgentMcpServer } from './mcp.js'

interface Options { readonly baseUrl: string; readonly actorId?: string; readonly token?: string; readonly scope?: string }

const usage = (): string => `Usage: dinkster-agent-mcp --base-url URL [--actor-id ID] [--token TOKEN] [--scope SCOPE]\nToken defaults to DINKSTER_AGENT_TOKEN.\n`

export function parseMcpArgs(args: readonly string[]): Options | undefined {
  let baseUrl: string | undefined
  let actorId: string | undefined
  let token = process.env['DINKSTER_AGENT_TOKEN']
  let scope: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--help' || arg === '-h') return undefined
    if (!['--base-url', '--actor-id', '--token', '--scope'].includes(arg)) throw new Error(`unknown argument: ${arg}`)
    const value = args[++index]
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`)
    if (arg === '--base-url') baseUrl = value.replace(/\/$/, '')
    else if (arg === '--token') token = value
    else if (arg === '--scope') scope = value
    else actorId = value
  }
  if (baseUrl === undefined) throw new Error('--base-url is required')
  return { baseUrl, ...(actorId !== undefined && { actorId }), ...(token !== undefined && { token }), ...(scope !== undefined && { scope }) }
}

async function main(): Promise<void> {
  const options = parseMcpArgs(process.argv.slice(2))
  if (options === undefined) { console.log(usage()); return }
  const authorization = await credentialFetch({ token: options.token, actorKind: 'agent' })(
    `${options.baseUrl}/api/auth/ws-ticket`, { method: 'POST' },
  )
  if (!authorization.ok) throw new Error(`Agent authorization failed (${authorization.status}); supply a delegation with --token or DINKSTER_AGENT_TOKEN`)
  const host = createAgentMcpServer(options.baseUrl, options.actorId, undefined, options)
  const transport = new StdioServerTransport()
  const close = async () => {
    host.close()
    await host.server.close()
  }
  process.once('SIGINT', () => void close())
  process.once('SIGTERM', () => void close())
  transport.onclose = () => host.close()
  await host.server.connect(transport)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  console.error(usage())
  process.exitCode = 1
})
