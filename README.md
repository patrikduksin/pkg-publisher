# pkg.patrikduksin.com

Thin Alchemy stack that deploys the existing `@alchemy.run/pr-package` Worker to the personal Cloudflare account at <https://pkg.patrikduksin.com>.

## Prerequisites

- The Alchemy fork is checked out at `../alchemy` and its dependencies are installed with `bun i`.
- Alchemy's `personal` profile is logged in to the Cloudflare account that owns `patrikduksin.com`. Never use the `default` profile for this stack.

`bun i` registers the sibling fork packages in Bun's global link registry because Bun 1.3.14 does not resolve relative `link:` paths.

## Deploy and verify

```sh
bun i
bun run deploy
bun run token
bun run smoke
```

`bun run token` reads the deployed `Pkg/prod` state and writes the bearer token to the ignored `.auth-token` file with mode `0600`. It does not print the token.

After syncing and reinstalling the sibling Alchemy fork, run `bun run deploy` again to deploy its current `@alchemy.run/pr-package` implementation.

## Teardown

```sh
bun run destroy
```
