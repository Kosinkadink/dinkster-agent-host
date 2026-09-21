# Source revisions

The agent host consumes unpublished Dinkster TypeScript packages through this
workspace. `packages/client` and `packages/core` are vendored byte-for-byte
from this pinned Dinkster-Frontend revision:

`53bf43576ad0774c7a148428c5ca72d2f96e33af`

The local end-to-end procedure uses this pinned Dinkster revision:

`444328290949f58d0693ca2b4491b1c55817db1a`

`pnpm verify:pins` checks the tracked package trees against their source-tree
digests. Update a pin and its vendored tree together. The vendored packages can
be replaced with normal package dependencies when `@dinkster/client` and
`@dinkster/core` are published.
