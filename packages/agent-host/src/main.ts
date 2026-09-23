#!/usr/bin/env -S tsx
import { userInfo } from 'node:os'
import { readFile, writeFile } from 'node:fs/promises'
import { credentialFetch, mintDelegation } from '@dinkster/client'
import type { CollabDenial, Diagnostic, ExecutionScope, Json, NormalizedEvent } from '@dinkster/core'
import { commandCatalog } from './catalog.js'
import {
  connect,
  createSession,
  defaultActorId,
  listSessions,
  type AgentSessionHandle,
} from './api.js'
import { captureExecutionDenial } from './execution.js'

export type CliAction =
  | 'login' | 'sessions-list' | 'sessions-create' | 'commands-list' | 'document-get' | 'dispatch'
  | 'document-compile' | 'job-submit' | 'job-cancel' | 'job-inspect' | 'job-outputs'
  | 'execution-events' | 'value-get' | 'problems-get' | 'propose-setting' | 'help'

export interface CliOptions {
  readonly action: CliAction
  readonly baseUrl?: string
  readonly sessionId?: string
  readonly actorId: string
  readonly owner: string
  readonly command?: string
  readonly params?: Json
  readonly executionScope?: ExecutionScope
  readonly jobId?: string
  readonly nodeId?: string
  readonly outputId?: string
  readonly element?: readonly number[]
  readonly waitMs?: number
  readonly settingId?: string
  readonly value?: Json
  readonly note?: string
  readonly hold?: number
  readonly helpTopic?: string
  readonly token?: string
  readonly collaborationScope?: string
  readonly sessionTokenFile?: string
  readonly tokenFile?: string
}

const rootUsage = (): string => `Usage: dinkster-agent [global flags] <command>

Commands:
  login               Mint a delegation from a user session credential file
  sessions list       List shared sessions
  sessions create     Create an empty shared session
  commands list       List registered command metadata
  document get        Get the current session document
  dispatch            Dispatch a command to a session
  document compile    Compile the current session document
  job submit          Compile and submit the current session document
  job cancel          Cancel one job
  job inspect         Fetch one retained job and its Problems
  job outputs         Fetch retained output descriptors
  execution events    Read normalized execution events
  value get           Inspect one retained output value
  problems get        Read current document, collaboration, and job Problems
  propose-setting     Propose a browser setting change for human review

Global flags:
  --token TOKEN       Delegation credential (or DINKSTER_AGENT_TOKEN)
  --scope SCOPE       Delegation/discovery scope (default: shared)
  --session-token-file FILE  User credential input for login only
  --token-file FILE    Private delegation output file for login
  --base-url URL       Dinkster server URL (required except for commands list)
  --session ID         Shared session id (required for document and execution tools)
  --actor-id ID        Participant id (default: agent-<random suffix>)
  --owner NAME         Person running this agent (default: OS username)
  -h, --help           Show help
`

export function usage(topic?: string): string {
  switch (topic) {
    case 'sessions': return `Usage: dinkster-agent [global flags] sessions <list|create>\n`
    case 'sessions list': return `Usage: dinkster-agent --base-url URL sessions list\n`
    case 'sessions create': return `Usage: dinkster-agent --base-url URL sessions create\n`
    case 'commands': return `Usage: dinkster-agent commands list\n`
    case 'commands list': return `Usage: dinkster-agent commands list\n`
    case 'document': return `Usage: dinkster-agent --base-url URL --session ID document get\n`
    case 'document get': return `Usage: dinkster-agent --base-url URL --session ID document get\n`
    case 'document compile': return `Usage: dinkster-agent --base-url URL --session ID document compile [--execution-scope JSON]\n`
    case 'dispatch': return `Usage: dinkster-agent --base-url URL --session ID dispatch --command ID --params JSON\n`
    case 'job submit': return `Usage: dinkster-agent --base-url URL --session ID job submit [--execution-scope JSON]\n`
    case 'job cancel': return `Usage: dinkster-agent --base-url URL --session ID job cancel --job ID\n`
    case 'job inspect': return `Usage: dinkster-agent --base-url URL --session ID job inspect --job ID\n`
    case 'job outputs': return `Usage: dinkster-agent --base-url URL --session ID job outputs --job ID\n`
    case 'execution events': return `Usage: dinkster-agent --base-url URL --session ID execution events [--job ID] [--wait MS]\n`
    case 'value get': return `Usage: dinkster-agent --base-url URL --session ID value get --job ID --node ID --output ID [--element JSON]\n`
    case 'problems get': return `Usage: dinkster-agent --base-url URL --session ID problems get [--job ID]\n`
    case 'propose-setting': return `Usage: dinkster-agent --base-url URL --session ID propose-setting --setting ID --value JSON [--note TEXT] [--hold SECONDS]\n\nThe proposal is ephemeral and disappears when this publisher disconnects. Hold defaults to 300 seconds.\n`
    default: return rootUsage()
  }
}

function readValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

function parseExecutionScope(raw: string): ExecutionScope {
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('--execution-scope must be valid JSON') }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('--execution-scope must be a full or partial execution scope')
  }
  const scope = value as Record<string, unknown>
  if (scope['kind'] === 'full') return { kind: 'full' }
  if (scope['kind'] !== 'partial' || !Array.isArray(scope['targets']) || scope['targets'].length === 0 ||
      !scope['targets'].every((target) => typeof target === 'object' && target !== null &&
        typeof (target as Record<string, unknown>)['node'] === 'string' &&
        Array.isArray((target as Record<string, unknown>)['instancePath']) &&
        ((target as Record<string, unknown>)['instancePath'] as unknown[]).every((id) => typeof id === 'string'))) {
    throw new Error('--execution-scope must be a full or partial execution scope')
  }
  return value as ExecutionScope
}

export function parseArgs(args: readonly string[]): CliOptions {
  let baseUrl: string | undefined
  let token = process.env['DINKSTER_AGENT_TOKEN']
  let collaborationScope = 'shared'
  let sessionTokenFile: string | undefined
  let tokenFile: string | undefined
  let sessionId: string | undefined
  let actorId = defaultActorId()
  let owner = userInfo().username
  let command: string | undefined
  let params: Json | undefined
  let executionScope: ExecutionScope | undefined
  let jobId: string | undefined
  let nodeId: string | undefined
  let outputId: string | undefined
  let element: readonly number[] | undefined
  let waitMs: number | undefined
  let settingId: string | undefined
  let value: Json | undefined
  let note: string | undefined
  let hold = 300
  const words: string[] = []
  let help = false

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    switch (arg) {
      case '--': break
      case '--token': token = readValue(args, index++, arg); break
      case '--scope': collaborationScope = readValue(args, index++, arg); break
      case '--session-token-file': sessionTokenFile = readValue(args, index++, arg); break
      case '--token-file': tokenFile = readValue(args, index++, arg); break
      case '--base-url': baseUrl = readValue(args, index++, arg).replace(/\/$/, ''); break
      case '--session': sessionId = readValue(args, index++, arg); break
      case '--actor-id': actorId = readValue(args, index++, arg); break
      case '--owner': owner = readValue(args, index++, arg); break
      case '--command': command = readValue(args, index++, arg); break
      case '--params': {
        const raw = readValue(args, index++, arg)
        try { params = JSON.parse(raw) as Json } catch { throw new Error('--params must be valid JSON') }
        break
      }
      case '--execution-scope': executionScope = parseExecutionScope(readValue(args, index++, arg)); break
      case '--job': jobId = readValue(args, index++, arg); break
      case '--node': nodeId = readValue(args, index++, arg); break
      case '--output': outputId = readValue(args, index++, arg); break
      case '--element': {
        const raw = readValue(args, index++, arg)
        let parsed: unknown
        try { parsed = JSON.parse(raw) } catch { throw new Error('--element must be a JSON array of non-negative integers') }
        if (!Array.isArray(parsed) || !parsed.every((index) => Number.isInteger(index) && index >= 0)) {
          throw new Error('--element must be a JSON array of non-negative integers')
        }
        element = parsed as number[]
        break
      }
      case '--wait': {
        waitMs = Number(readValue(args, index++, arg))
        if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30_000) throw new Error('--wait must be an integer from 0 to 30000 milliseconds')
        break
      }
      case '--setting': settingId = readValue(args, index++, arg); break
      case '--value': {
        const raw = readValue(args, index++, arg)
        try { value = JSON.parse(raw) as Json } catch { throw new Error('--value must be valid JSON') }
        break
      }
      case '--note': note = readValue(args, index++, arg); break
      case '--hold': {
        hold = Number(readValue(args, index++, arg))
        if (!Number.isFinite(hold) || hold < 0) throw new Error('--hold must be a non-negative number of seconds')
        break
      }
      case '--help':
      case '-h': help = true; break
      default:
        if (arg.startsWith('-')) throw new Error(`unknown argument: ${arg}`)
        words.push(arg)
    }
  }

  const topic = words.join(' ')
  if (help || words.length === 0) return { action: 'help', actorId, owner, helpTopic: topic }
  const action = ({
    login: 'login',
    'sessions list': 'sessions-list',
    'sessions create': 'sessions-create',
    'commands list': 'commands-list',
    'document get': 'document-get',
    'document compile': 'document-compile',
    dispatch: 'dispatch',
    'job submit': 'job-submit',
    'job cancel': 'job-cancel',
    'job inspect': 'job-inspect',
    'job outputs': 'job-outputs',
    'execution events': 'execution-events',
    'value get': 'value-get',
    'problems get': 'problems-get',
    'propose-setting': 'propose-setting',
  } as const)[topic]
  if (action === undefined) {
    if (['sessions', 'commands', 'document', 'job', 'execution', 'value', 'problems'].includes(topic)) {
      return { action: 'help', actorId, owner, helpTopic: topic }
    }
    throw new Error(`unknown command: ${topic}`)
  }
  if (action !== 'commands-list' && baseUrl === undefined) throw new Error('--base-url is required')
  if (action === 'login' && (sessionTokenFile === undefined || tokenFile === undefined)) throw new Error('login requires --session-token-file and --token-file')
  if (!['login', 'commands-list', 'sessions-list', 'sessions-create'].includes(action) && sessionId === undefined) {
    throw new Error('--session is required')
  }
  if (action === 'dispatch' && command === undefined) throw new Error('--command is required')
  if (action === 'dispatch' && params === undefined) throw new Error('--params is required')
  if (action === 'propose-setting' && settingId === undefined) throw new Error('--setting is required')
  if (action === 'propose-setting' && value === undefined) throw new Error('--value is required')
  if (['job-cancel', 'job-inspect', 'job-outputs', 'value-get'].includes(action) && jobId === undefined) {
    throw new Error('--job is required')
  }
  if (action === 'value-get' && nodeId === undefined) throw new Error('--node is required')
  if (action === 'value-get' && outputId === undefined) throw new Error('--output is required')
  return {
    action, actorId, owner,
    collaborationScope,
    ...(token !== undefined && { token }),
    ...(sessionTokenFile !== undefined && { sessionTokenFile }),
    ...(tokenFile !== undefined && { tokenFile }),
    ...(baseUrl !== undefined && { baseUrl }),
    ...(sessionId !== undefined && { sessionId }),
    ...(command !== undefined && { command }),
    ...(params !== undefined && { params }),
    ...(executionScope !== undefined && { executionScope }),
    ...(jobId !== undefined && { jobId }),
    ...(nodeId !== undefined && { nodeId }),
    ...(outputId !== undefined && { outputId }),
    ...(element !== undefined && { element }),
    ...(waitMs !== undefined && { waitMs }),
    ...(settingId !== undefined && { settingId }),
    ...(value !== undefined && { value }),
    ...(note !== undefined && { note }),
    ...(action === 'propose-setting' && { hold }),
  }
}

const terminalExecutionEvent = (event: NormalizedEvent): boolean =>
  event.kind === 'completed' || event.kind === 'error' || event.kind === 'interrupted'

const terminalEventAuthorizationProblem = (problem: Diagnostic): boolean =>
  problem.code.startsWith('execution.events.') || problem.code.startsWith('execution.ws-ticket.')

export async function followExecutionEvents(
  handle: Pick<AgentSessionHandle, 'events'>,
  input: { readonly jobId?: string; readonly waitMs?: number },
): Promise<{
  readonly events: readonly { readonly cursor: number; readonly event: NormalizedEvent }[]
  readonly problems: readonly Diagnostic[]
}> {
  const events: { cursor: number; event: NormalizedEvent }[] = []
  const problems = new Map<string, Diagnostic>()
  const deadline = Date.now() + (input.waitMs ?? 0)
  const waitForTerminalEvent = input.waitMs !== undefined
  let cursor = 0
  do {
    const remaining = Math.max(0, deadline - Date.now())
    const page = await handle.events({
      after: cursor,
      ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
      ...(input.waitMs === undefined ? {} : { waitMs: remaining }),
    })
    events.push(...page.events)
    for (const problem of page.problems) problems.set(`${problem.code}\n${problem.message}`, problem)
    cursor = page.nextCursor
    if (page.events.some(({ event }) => terminalExecutionEvent(event)) ||
        page.problems.some(terminalEventAuthorizationProblem) || !waitForTerminalEvent) break
  } while (Date.now() < deadline)
  return { events, problems: [...problems.values()] }
}

export async function runCli(options: CliOptions, connectAgent: typeof connect = connect): Promise<unknown> {
  const onDiagnostic = (diagnostic: CollabDenial) => {
    console.error(JSON.stringify(diagnostic))
  }
  const connectForCli = () => connectAgent(options.baseUrl!, options.sessionId!, {
    token: options.token,
    actorId: options.actorId, harness: 'cli', owner: options.owner,
    onDiagnostic,
  })
  switch (options.action) {
    case 'login': {
      const sessionToken = (await readFile(options.sessionTokenFile!, 'utf8')).trim()
      const delegation = await mintDelegation(options.baseUrl!, {
        scope: options.collaborationScope ?? 'shared', displayName: options.owner,
        ...(options.sessionId !== undefined && { sessionId: options.sessionId }),
      }, credentialFetch({ token: sessionToken }))
      await writeFile(options.tokenFile!, `${delegation.token}\n`, { mode: 0o600, flag: 'wx' })
      return { tokenFile: options.tokenFile, expiresAt: delegation.expiresAt }
    }
    case 'help': return usage(options.helpTopic)
    case 'commands-list': return commandCatalog
    case 'sessions-list': return listSessions(options.baseUrl!, options.token, options.collaborationScope, { onDiagnostic })
    case 'sessions-create': return createSession(options.baseUrl!, { token: options.token, scope: options.collaborationScope, onDiagnostic })
    case 'document-get': {
      const handle = await connectForCli()
      try { return handle.getDocument() } finally { handle.close() }
    }
    case 'dispatch': {
      const handle = await connectForCli()
      try {
        const result = handle.dispatch(options.command!, options.params!)
        await handle.settle()
        return result
      } finally { handle.close() }
    }
    case 'document-compile': {
      const handle = await connectForCli()
      try { return await handle.compile(options.executionScope) } finally { handle.close() }
    }
    case 'job-submit': {
      const handle = await connectForCli()
      try { return await handle.submit(options.executionScope) } finally { handle.close() }
    }
    case 'job-cancel': {
      const handle = await connectForCli()
      try {
        return await captureExecutionDenial(async () => {
          await handle.cancel(options.jobId!)
          return { cancelled: options.jobId }
        })
      } finally { handle.close() }
    }
    case 'job-inspect': {
      const handle = await connectForCli()
      try {
        return await captureExecutionDenial(() => handle.inspect(options.jobId!))
      } finally { handle.close() }
    }
    case 'job-outputs': {
      const handle = await connectForCli()
      try {
        return await captureExecutionDenial(() => handle.outputs(options.jobId!))
      } finally { handle.close() }
    }
    case 'execution-events': {
      const handle = await connectForCli()
      try {
        return await followExecutionEvents(handle, {
          ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
          ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }),
        })
      } finally { handle.close() }
    }
    case 'value-get': {
      const handle = await connectForCli()
      try {
        return await handle.value({
          jobId: options.jobId!, nodeId: options.nodeId!, outputId: options.outputId!,
          ...(options.element === undefined ? {} : { element: options.element }),
        })
      } finally { handle.close() }
    }
    case 'problems-get': {
      const handle = await connectForCli()
      try { return await handle.problems(options.jobId) } finally { handle.close() }
    }
    case 'propose-setting': {
      const handle = await connectForCli()
      try {
        const proposalId = handle.proposeSetting({
          settingId: options.settingId!, value: options.value!, ...(options.note !== undefined ? { note: options.note } : {}),
        })
        await new Promise((resolve) => setTimeout(resolve, options.hold! * 1000))
        return { proposalId }
      } finally { handle.close() }
    }
  }
}

export const formatCliResult = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2)

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const result = await runCli(options)
  console.log(formatCliResult(result))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    console.error(rootUsage())
    process.exitCode = 1
  })
}
