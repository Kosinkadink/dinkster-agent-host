# Prompt (compile output) golden fixtures

Each `<name>.expected.json` is the prompt the compiler must emit for
`../workflows/<name>.json` under a full ExecutionScope. Both expected prompts
in this directory were submitted to a real ComfyUI server and executed
successfully (HTTP 200, `execution_success`), including the occurrence-key
node ids - so every rule below is grounded, not guessed.

Compile contract rules pinned by these fixtures:

1. **Runtime node id = occurrence key** (`occurrenceKey()` from `@dinkster/core`):
   the source node id for root-graph nodes (`n1`), instance-path-qualified for
   nodes inside subgraph instances (`n0.n0` = node `n0` inside instance `n0`).
   The separator is `.` (segments percent-escape `.`, `/`, `[`, `]`, `$`)
   because the Dinkster backend bans `/`, `[` and `]` in document node ids -
   they belong to its runtime iteration-path grammar (`outer[0]/inner[2]/n`).
   The current server accepts these ids verbatim (verified with the earlier
   `/`-separated form; node ids are opaque strings to ComfyUI). Provenance maps
   stay explicit anyway because lowering may synthesize nodes (bypass
   passthroughs, net expansion).
2. **Widget values are keyed by schema input id** - never positional.
3. **Links lower to `[producerRuntimeId, outputIndex]`** where `outputIndex`
   is the producer's position among its schema outputs (compiler OUTPUT only;
   indexes are never identity anywhere else).
4. **Subgraph instances flatten away**: boundary inputs resolve through to the
   bound inner port; instance values for PROMOTED widgets override the inner
   node's stored value (`color: 123` beats the inner `0`).
5. Nodes outside the execution scope, muted nodes, and structural constructs
   (nets, reroutes) never appear in the prompt (covered by later fixtures
   once the compiler exists).
