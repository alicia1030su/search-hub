# @search-hub/cli

Standalone `shub` client for the Search Hub REST API. See
[`docs/cli.md`](../../docs/cli.md) for installation, security and command details.

Development:

```bash
pnpm --filter @search-hub/cli build
node packages/cli/dist/index.mjs --help
pnpm test:cli
```

The package never stores bearer tokens in plaintext configuration. Use
`SEARCH_HUB_TOKEN` or `--token-stdin`.
