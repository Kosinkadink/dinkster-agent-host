# Source revisions

The agent host consumes unpublished Dinkster TypeScript packages through this
workspace. `packages/client` and `packages/core` are vendored byte-for-byte
from this pinned Dinkster-Frontend revision:

[`3a6648c3a7fcc07a3fc9d5bedeacb0f4c90861bf`](https://github.com/Kosinkadink/Dinkster-Frontend/commit/3a6648c3a7fcc07a3fc9d5bedeacb0f4c90861bf)

`pnpm verify:pins` checks the tracked package trees against their source-tree
digests. Update a pin and its vendored tree together. The vendored packages can
be replaced with normal package dependencies when `@dinkster/client` and
`@dinkster/core` are published.
