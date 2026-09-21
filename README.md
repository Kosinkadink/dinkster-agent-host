# Dinkster agent host

`@dinkster/agent-host` lets an external agent harness inspect and edit Dinkster
shared sessions without owning their lifecycle. It never ends or deletes a
server session. Node 22 or newer is required.

An agent is a delegate of its user, not a second user. Its operations use a
distinct actor id while the server applies the authenticated user's grants,
agent permission toggles, and shared-session role.

## Development

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

`@dinkster/client` and `@dinkster/core` are not published. This repository
workspace-links pinned, byte-identical source trees for them. See
[`SOURCE_REVISIONS.md`](SOURCE_REVISIONS.md) for the revisions and verification
command.

## TypeScript API

```ts
import { connect, createSession } from '@dinkster/agent-host'

const created = await createSession('http://127.0.0.1:8792')
const session = await connect('http://127.0.0.1:8792', created.sessionId, {
  owner: 'alice',
  harness: 'my-agent',
  displayName: 'Workflow agent',
})
const result = session.dispatch('node.add', {
  graphId: 'g0',
  type: 'KSampler',
  position: { x: 100, y: 100 },
})
if (!result.ok) console.error(result.diagnostics)
await session.settle()
const submitted = await session.submit()
if (!submitted.ok) {
  console.error(submitted.diagnostics)
} else {
  const page = await session.events({ jobId: submitted.execution.prompt, waitMs: 30_000 })
  console.log(page.events)
  console.log(await session.inspect(submitted.execution.prompt))
  console.log(await session.outputs(submitted.execution.prompt))
}
const proposalId = session.proposeSetting({
  settingId: 'canvas.grid.visible',
  value: false,
  note: 'Reduce visual clutter',
})
session.withdrawProposal(proposalId)
console.log(session.getDocument())
session.close()
```

`listSessions(baseUrl)` lists the sessions in the `shared` scope. The optional
third argument to `connect` accepts `actorId`, `displayName`, `owner`, and
`harness`. The package creates an `agent-<random suffix>` actor id when none is
provided. While connected, every handle announces that it is an agent and
refreshes that presence every two seconds until `close()`.
`proposeSetting` adds a setting proposal to that ephemeral presence and
returns its id; `withdrawProposal` removes it. Proposals never write browser
settings directly. A human participant reviews and applies them locally.

`compile(scope)` fetches the current native schema catalog and compiles the
session's acknowledged document revision through the core compiler. `submit`
compiles and submits only when no diagnostic blocks execution. Both accept a
full scope (the default) or a partial scope with explicit occurrences. The
native job connection uses the agent actor id as its `clientId`, preserving
run attribution and routing cancellation, replay, output, and value requests
to that agent's jobs.

`events({ after, jobId, waitMs })` returns normalized execution events, retained
operation Problems, and a cursor for polling or long-polling (up to 30 seconds
through MCP).
The first job-specific read replays its retained record before following live
events. `inspect(jobId)` returns the retained job, derived execution state,
and runtime Problems. `problems(jobId?)` recompiles the current document and
combines its canonical diagnostics with collaboration, operation, and optional
job Problems. Authorization refusals from event connection, submit, cancel,
inspect, outputs, and value requests retain the server status, code, and
message. An event authorization refusal is terminal for that connection rather
than an automatic reconnect loop. Direct MCP and CLI operations return these
refusals as `{ ok: false, diagnostics: [...] }`. `outputs(jobId)` returns retained descriptors;
`value(query)` preserves the native value client's structured success/refusal
union. `cancel(jobId)` targets only that actor's exact job identity.

TypeScript and MCP handles retain event cursors for their connection lifetime.
The CLI does not expose those process-local cursors: `execution events --wait`
keeps one connection open, follows until a terminal event or the wait deadline,
and returns every event and operation Problem collected during that invocation.

## MCP stdio server

An MCP-capable client can launch the stdio server from a checkout:

```json
{
  "mcpServers": {
    "dinkster": {
      "command": "pnpm",
      "args": [
        "--dir", "/path/to/dinkster-agent-host/packages/agent-host",
        "start:mcp", "--", "--base-url", "http://127.0.0.1:8792"
      ]
    }
  }
}
```

The server provides `sessions_list`, `session_create`, `commands_list`,
`document_get`, `command_dispatch`, `document_compile`, `job_submit`,
`job_cancel`, `job_inspect`, `execution_events`, `job_outputs`, `value_get`,
`problems_get`, `propose_setting`, and `withdraw_proposal`. Session-bound tools
take `sessionId`. It joins sessions lazily, reuses one
connection per session, and closes those connections when the server exits.
Each connection announces the OS username as its owner and `mcp` as its
harness.

## CLI

```sh
pnpm --filter @dinkster/agent-host start -- --base-url http://127.0.0.1:8792 sessions create
pnpm --filter @dinkster/agent-host start -- commands list
pnpm --filter @dinkster/agent-host start -- \
  --base-url http://127.0.0.1:8792 --session SESSION_ID \
  dispatch --command node.add \
  --params '{"graphId":"g0","type":"KSampler","position":{"x":100,"y":100}}'
pnpm --filter @dinkster/agent-host start -- \
  --base-url http://127.0.0.1:8792 --session SESSION_ID document get
pnpm --filter @dinkster/agent-host start -- \
  --base-url http://127.0.0.1:8792 --session SESSION_ID --actor-id AGENT_ID job submit
pnpm --filter @dinkster/agent-host start -- \
  --base-url http://127.0.0.1:8792 --session SESSION_ID --actor-id AGENT_ID \
  execution events --job JOB_ID --wait 30000
pnpm --filter @dinkster/agent-host start -- \
  --base-url http://127.0.0.1:8792 --session SESSION_ID --actor-id AGENT_ID \
  value get --job JOB_ID --node RUNTIME_NODE_ID --output OUTPUT_ID
pnpm --filter @dinkster/agent-host start -- \
  --base-url http://127.0.0.1:8792 --session SESSION_ID \
  propose-setting --setting canvas.grid.visible --value false \
  --note 'Reduce visual clutter' --hold 300
```

Run any command level with `--help` for its usage. The curated command catalog
is discovery metadata, not an allowlist: dispatch accepts every command id,
and the connected document session performs authoritative validation and
returns refusals as diagnostics.

The CLI announces `cli` as its harness. Use `--owner NAME` to override the OS
username associated with its agent presence.
Use the same explicit `--actor-id` for a submitted job and later job/value
commands; the server keys native jobs by that client id. MCP keeps one actor id
for the process automatically.
`propose-setting` keeps the connection open for `--hold` seconds, defaulting
to 300. Its proposal disappears when the command disconnects.

## Authentication

Dinkster authentication is off by default, so a local auth-off server needs no
credential. When authentication is enabled, create a short-lived delegation
from the frontend's **Connect agent** control and pass it through
`DINKSTER_AGENT_TOKEN` or `--token`. The delegation is a bearer credential and
must be kept out of source control, logs, process listings, and recorded shell
commands. Never give an agent the user's full session credential.

The CLI can exchange a private user-session file for a delegation file without
printing either credential:

```sh
pnpm --filter @dinkster/agent-host exec tsx src/main.ts \
  --base-url http://127.0.0.1:8792 login --scope shared \
  --session-token-file /private/user-session \
  --token-file /private/agent-delegation
```

The output file is created with mode 0600. Session-scoped delegations can only
access their named session and WebSocket tickets. Scope-wide delegations are
required for session discovery, session creation, and jobs.

## Pinned local end-to-end example

The recorded compatibility target is Dinkster-Frontend
`53bf43576ad0774c7a148428c5ca72d2f96e33af` with Dinkster
`444328290949f58d0693ca2b4491b1c55817db1a`. Check both sibling repositories
at those revisions, start `dinkster-serve` on `127.0.0.1:8792`, and start the
frontend against that server. In the frontend, create or open a shared session.
Then run:

```sh
SESSION_ID="replace-with-the-shared-session-id"
pnpm --filter @dinkster/agent-host start -- \
  --base-url http://127.0.0.1:8792 --session "$SESSION_ID" \
  dispatch --command node.add \
  --params '{"graphId":"g0","type":"dinkster.int","position":{"x":100,"y":100}}'
```

The command must return an `ok` result and the new node must appear in the open
frontend session. With authentication enabled, set `DINKSTER_AGENT_TOKEN` to a
delegation before running the same command. The live integration tests use
`DINKSTER_AGENT_LIVE_URL=http://127.0.0.1:8792 pnpm test` to exercise compile,
submit, event, output, value, replay, and cancellation against the same server.
