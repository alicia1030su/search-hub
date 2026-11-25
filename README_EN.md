<a id="top"></a>
# Search Hub

**Self-hosted AI search infrastructure that unifies multiple search providers and key pools behind REST, MCP, Agent Skills, and one CLI.**

[中文](./README.md) · [Deployment](./docs/deployment.md) · [CLI](./docs/cli.md) · [API](./docs/api.md)

> **v0.1.16 Stable.** This release focuses on verified bug fixes, release reliability, and concise documentation; see the [CHANGELOG](./CHANGELOG.md) for details.
>
> Stable is a public release channel, not a claim that every third-party integration is production-certified; see “Limits” below.
<a id="highlights"></a>
## Highlights

| Highlight | What it does |
|---|---|
| Concurrent providers, partial success | One provider failure does not fail the whole search; usable results and explicit failures are returned |
| Key pools and quota controls | Per-key concurrency, RPM, daily quota, cooldown, and circuit breaking with multiple scheduling strategies |
| Unified results and fusion | URL normalization, deduplication, and RRF fusion while preserving source attribution and original ranks |
| Persistent cache and resource visibility | SQLite cache with TTL/LRU, plus admin views for cache, queues, and process resources |
| Encrypted backup and isolated restore | `.shbackup` includes a consistent database and matching master key; restore is dry-run by default |
| Four entry points, one engine | REST, MCP, Agent Skills, and `shub` CLI all use the same server-side search path |

<a id="screenshots"></a>
## Interface

<!-- CAPTURE_REQUIRED: replace with the real v0.1.16 docs/screenshots/v0116/dashboard.png after capture. -->
<!-- CAPTURE_REQUIRED: replace with the real v0.1.16 docs/screenshots/v0116/search-lab.png after capture. -->
<!-- CAPTURE_REQUIRED: replace with the real v0.1.16 docs/screenshots/v0116/provider-health.png after capture. -->

<a id="quick-start"></a>
## Quick start

| Deployment | Requirements | Start command |
|---|---|---|
| Windows x64 standalone | No Node/pnpm/Docker | Run `SearchHub.exe` after extraction |
| Linux x64 standalone | No Node/pnpm | `./bin/search-hub` |
| Linux arm64 standalone | No Node/pnpm | `./bin/search-hub` |
| Docker Compose | Docker | `docker compose up -d` |

### Docker Compose

```bash
git clone https://github.com/alicia1030su/search-hub.git
cd search-hub
cp .env.example .env
# Recommended: set a stable master key with: openssl rand -hex 32
# Put the 64-character hex value into SEARCH_HUB_ENCRYPTION_KEY in .env
docker compose up -d
docker compose logs -f search-hub
curl -fsS http://127.0.0.1:8787/api/health
```

Open `http://127.0.0.1:8787` to create the administrator; there is no default account. First-run setup requires a one-time token:

```bash
docker compose exec search-hub cat /app/data/setup-token
```

Use the command above only when `SEARCH_HUB_SETUP_TOKEN` is unset; the token value is not printed to the log, so read the 0600 file. Deletion after initialization is best-effort, and any residual token is invalid.

### Windows x64

1. Download `search-hub-v0.1.16-windows-x64.zip` from the Release below and verify it.
2. Extract it to a writable directory; data lives in `%LOCALAPPDATA%\SearchHub`.
3. Read `%LOCALAPPDATA%\SearchHub\setup-token` before first setup; start once if it has not been generated yet.
4. Double-click `SearchHub.exe`, then enter the token at `/setup` and create the administrator.

### Linux x64 / arm64

```bash
# Linux x64
mkdir search-hub
tar -xzf search-hub-v0.1.16-linux-x64.tar.gz -C search-hub
cd search-hub && ./bin/search-hub
```

For Linux arm64, use `search-hub-v0.1.16-linux-arm64.tar.gz`; the remaining steps are identical. The default listener is `127.0.0.1:8787`; use the bundled `search-hub.service` for long-running deployments.

**Download and verify**

Download the assets below from the [v0.1.16 Release](https://github.com/alicia1030su/search-hub/releases/tag/v0.1.16); standalone server packages already include a runtime.

| Platform / use | Server | CLI `shub` | Extra requirement |
|---|---|---|---|
| Windows x64 | `search-hub-v0.1.16-windows-x64.zip` | `shub-v0.1.16-windows-x64.zip` | None |
| Linux x64 | `search-hub-v0.1.16-linux-x64.tar.gz` | `shub-v0.1.16-linux-x64.tar.gz` | None |
| Linux arm64 | `search-hub-v0.1.16-linux-arm64.tar.gz` | `shub-v0.1.16-linux-arm64.tar.gz` | None |
| Node.js >=22.12.0 portable CLI | — | `shub-v0.1.16-node22.tar.gz` | Node.js >=22.12.0 |

The Release also provides `SHA256SUMS` and `resource-evidence.json`, for nine assets in total; verify after downloading:

```bash
sha256sum -c SHA256SUMS
```

To use the published image from the cloned repository (the image is built for `linux/amd64` only):

```bash
SEARCH_HUB_IMAGE=ghcr.io/alicia1030su/search-hub:0.1.16 docker compose up -d
```

Use the arm64 standalone package on arm64 hosts; Docker arm64 emulation is outside the project's tested configurations.

<a id="interfaces"></a>
## REST / MCP / Skills / CLI

| Entry point | Address / form | Authentication | Docs |
|---|---|---|---|
| REST | `POST /api/search`, `/api/search/deep` | Bearer with `search` scope | [API](./docs/api.md) |
| MCP HTTP | `POST /mcp`, Streamable HTTP | Bearer with `mcp:use`; search tools also need `search`; `get_search_sources` also needs `sources:read` | [MCP](./docs/mcp.md) |
| MCP stdio | `packages/mcp/dist/stdio.mjs`, a proxy to the same REST API | The same token and layered scopes: `mcp:use`, `search` for search tools, and `sources:read` for `get_search_sources` | [MCP](./docs/mcp.md) |
| Agent Skills | `search-web`, `deep-research`, `research-with-citations` | `search` scope | [Skills](./docs/skills.md) |
| CLI | Standalone `shub`, reusing the REST API | Environment variable or `--token-stdin` | [CLI](./docs/cli.md) |

### CLI examples

```bash
export SEARCH_HUB_URL="http://127.0.0.1:8787"
export SEARCH_HUB_TOKEN="sh_replace_with_your_token"
shub status
shub search "Linux" --json
shub sources --enabled --json
```

`search` requires the `search` scope; `sources` also requires `sources:read`. JSON mode writes only valid JSON to stdout, and tokens are never written to plaintext config.

<a id="providers"></a>
## Provider categories

The catalogue contains 58 entries: 50 native adapters (4 `live_tested`, 45 `documented`, 1 `mock_verified`), 7 generic presets, and 1 entry with no official API. Hacker News, Crossref, OpenAlex, and PubMed are live-tested; a catalogue entry does not mean a verified working service. See the [Provider matrix](./docs/provider-matrix.md) for per-provider status.

<a id="docs"></a>
## Documentation

[Architecture](./docs/architecture.md) · [Deployment](./docs/deployment.md) · [Standalone packages](./docs/standalone-packages.md) · [Backup and recovery](./docs/disaster-recovery.md) · [Provider health](./docs/provider-health.md) · [Testing](./docs/testing.md)

[CHANGELOG](./CHANGELOG.md) · [Security](./SECURITY.md)

<a id="limits"></a>
## Limits

- Multi-instance deployment is not implemented: quota governance is per process and storage is SQLite; Redis coordination and PostgreSQL support are not implemented.
- Most paid providers have local contract tests only and have not been integration-tested with real credentials; do not treat them as production-certified.
- The quality lab currently uses synthetic fixtures to validate metric mechanics; it is not a vendor search ranking or a real relevance result.
- MCP returns a single JSON result; server-initiated SSE streaming subscriptions are not supported.

<a id="license"></a>
## License

Licensed under the [MIT License](./LICENSE).
