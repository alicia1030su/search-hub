# Search Hub

**Self-hosted AI search infrastructure.** One service that aggregates multiple search providers, manages pools of API keys, normalizes and fuses results, and exposes the same engine over REST, MCP, and Agent Skills.

[中文](./README.md) · [Architecture](./docs/architecture.md) · [Deployment](./docs/deployment.md) · [API](./docs/api.md) · [MCP](./docs/mcp.md) · [Skills](./docs/skills.md) · [Legacy migration](./docs/legacy-migration.md) · [Testing](./docs/testing.md) · [AC matrix](./docs/ac-matrix.md) · [Acceptance report](./docs/acceptance-report.md) · [Release readiness](./docs/release-readiness.md) · [Live validation plan](./docs/real-search-validation-plan.md) · [Capability inventory](./docs/capability-inventory.md) · [Remote acceptance](./docs/github-remote-acceptance-plan.md) · [Provider guide](./docs/provider-plugin-guide.md)

> **Status: 0.1.4 · public preview, not production-ready.**
>
> Core search, key scheduling, admin UI, REST, MCP (both protocol eras) and Skills are implemented and covered by 471 automated tests. **Hacker News is the only provider verified end to end over the real network.** Tavily, Bocha, Brave and SearXNG are implemented from their official docs and are **not yet verified against real search results**. **The Docker image and the 11-item container acceptance have passed on GitHub Actions (ubuntu-latest)** — 24/24, including compose start, initialisation, a real search, persistence, crash recovery, MCP and Trivy (0 HIGH / 0 CRITICAL).
>
> Evidence and gaps: [Verification](#verification), [provider matrix](./docs/provider-matrix.md), [capability inventory](./docs/capability-inventory.md), [release readiness](./docs/release-readiness.md). Nothing untested is described as verified.

---

## Why

A single search API gives you one quota, one point of failure, and one ranking. A home-grown aggregator then has to solve key rotation, rate limits, de-duplication, fusion, and agent protocols again.

Search Hub packages that as a deployable service:

- **Multi-provider fan-out** — one query hits several providers concurrently; a failing provider never fails the whole search, and partial results carry explicit failure reasons.
- **Key pools** — any number of keys per provider, with round-robin, random, weighted-random, least-used, and failover strategies. Per-key concurrency, RPM, daily quota, cooldown, and circuit breaking.
- **One result shape** — URL canonicalization, exact and near-duplicate merging, RRF fusion, and full source attribution with original ranks.
- **Three entry points, one engine** — REST, MCP, and Skills all call the same `executeSearch`.
- **Optional intelligence** — cited AI summaries, embedding-based semantic re-scoring, and reranking. All optional; basic search works with no model configured.

## Capabilities

| Capability | Status | Notes |
|---|---|---|
| Concurrent multi-source search + partial success | Implemented | Per-source timeout, global deadline, isolation, client cancellation |
| Key pool scheduling (5 strategies) | Implemented | Atomic slot reservation; 100 concurrent requests cannot exceed the per-key limit |
| 429 / 401 / 5xx handling | Implemented | 429 honours `Retry-After`; 401/403 suspends the key; 5xx backs off and trips a breaker |
| URL canonicalization + dedupe + RRF | Implemented | All sources retained; RRF `k` configurable (default 60) |
| Admin UI (light/dark, Chinese) | Implemented | Dashboard, sources, keys, models, search lab, integrations, settings, logs |
| REST + OpenAPI 3.1 | Implemented | `/api/openapi.json`, `/api/docs` |
| MCP server | Implemented | 2026-07-28 modern envelope + 2025-11-25 handshake; Streamable HTTP and stdio |
| Agent Skills | Implemented | Three `SKILL.md` packages |
| AI summary / embedding / rerank | Implemented, optional | OpenAI-compatible, Anthropic, Gemini, Cohere/Jina-compatible, custom HTTP |
| PostgreSQL | Not implemented | SQLite only; the data layer is isolated |
| Redis multi-instance coordination | Not implemented | Single-process quota guarantees only |

## Supported providers

**Implemented adapters (50 kinds)**

The table below lists the representative ones; the full, generated list is [`docs/provider-matrix.md`](./provider-matrix.md), which CI keeps in sync with `packages/providers/src/catalog.ts`.

| Type | Auth | Notes | Verification |
|---|---|---|---|
| `hackernews` | None | HN Search official hosted API (Algolia) | **live_tested** — evidence in `docs/live-evidence/hackernews.json` |
| `crossref` / `openalex` / `pubmed` | None | Public scholarly APIs | **live_tested** — recorded calls in `docs/live-evidence/` |
| `tavily` / `bocha` / `brave` / `searxng` | API key / optional | Written from official docs, covered by local contract tests | `documented` — **never called with a real key** |
| `minimax` | Bearer | Coding Plan `web_search`, protocol taken from the official MCP source | `documented` — no Coding Plan credential here |
| `metaso` / `metaso-mcp` | Bearer / none | Metaso `/api/v1/search`; plus an MCP compatibility entry | `documented` — endpoint and error envelope confirmed by a real unauthenticated probe |
| `duckduckgo` | None | Instant Answer API only — it is not a general web search, and the adapter says so in `warnings` | `documented` — the adapter states this in `warnings` |
| `gemini` / `grok` / `mimo` / `bailian` | API key | Grounded-answer adapters (`capability: grounded_answer`) | `documented` |
| `doubao` / `deepseek-search` / `qianfan-search` / `tencent-yuanbao` / `stepfun` | API key / key pair | Native search adapters | `documented` |
| `generic-http` | Configurable | Declarative request + response mapping | Tested against a local mock server |
| `search-hub-legacy` | Optional | Calls an existing Search Hub REST `/api/search`; read-only, reversible | Contract-tested against a local fake |
| `mock` | None | Deterministic test source | `mock_verified` — never counted as vendor coverage |

**Catalogue entries that cannot be created**: only `baidu`. It has no publicly available general web-search API, and scraping its HTML violates its terms, so the entry is kept as documentation. The seven `generic` presets (Search Gateway, Premium, ORZ Fetch and friends) **are** creatable — they need you to supply the endpoint and result paths.

> 58 catalogue entries: 50 native adapters, 1 with no official API, 7 generic presets. A fresh install contains no sources; add them from the marketplace. The project **does not claim support for 58 search engines** — "in the catalogue" is not "verified working". See [docs/provider-matrix.md](./docs/provider-matrix.md) per provider.

Three states are kept strictly apart: **implemented** (`builtin`, an adapter written against the vendor protocol), **contract-tested** (`mock_verified`, proves the code path against a local double and never touches the vendor), and **live-tested** (`live_tested`, backed by a recorded real call). Only Hacker News, Crossref, OpenAlex and PubMed are live-tested; every other adapter is implemented but unverified against the real service.

> The catalog has 29 entries: 8 usable adapters, 12 planned, 2 without an official API, 7 generic gateway presets. This project does **not** claim support for 29 providers. Per-provider live-test gaps: [docs/provider-matrix.md](./docs/provider-matrix.md).

## Quick start

### Docker Compose (recommended)

```bash
git clone https://github.com/alicia1030su/search-hub.git
cd search-hub
cp .env.example .env
# Strongly recommended: set a stable master key
# openssl rand -hex 32  →  SEARCH_HUB_ENCRYPTION_KEY
docker compose up -d
```

Open `http://localhost:8787`. The first visit creates the administrator account — there is no default password.

**First-run initialisation requires a one-time setup token.** When `SEARCH_HUB_SETUP_TOKEN` is unset the server generates `data/setup-token` (mode 0600) and logs only the file path, never the value. Read it with `docker compose exec search-hub cat /app/data/setup-token`, then paste it into the setup form. Without it nobody can claim the administrator account. Then:

1. **Sources → Add source**. Zero credentials: pick **Hacker News** (official Algolia API, live results) to validate the whole chain. With a key, pick **Tavily / Bocha / Brave**; with a self-hosted instance, pick SearXNG. All four non-HN adapters are `documented` (no live verification); see [the provider matrix](./docs/provider-matrix.md).
2. **Test** performs a real request and shows the exact error code on failure.
3. **Search lab**: run a query, inspect per-source latency, failures, dedupe counts, and fused ranks.
4. **Integrations**: create an access token and copy the MCP configuration.

### Local development

```bash
corepack pnpm install
corepack pnpm build      # web bundle + server bundle (dist/server.mjs)
corepack pnpm dev        # API :8787 + Vite :5173
corepack pnpm test       # unit + integration
```

Requires Node ≥ 22.12 (`better-sqlite3` 13, Vite 8) and pnpm 12.

## Keys and scheduling

Each provider can have multiple independent instances (`brave-eu`, `brave-us`) with their own URL, key pool, concurrency, priority, and strategy.

- **Encryption**: AES-256-GCM; the master key comes from `SEARCH_HUB_ENCRYPTION_KEY` or a generated `data/master.key`. The API only returns a first-4 + last-4 mask (for example `sk-1…abcd`).
- **Strategies**: `round_robin`, `random`, `weighted_random`, `least_used`, `failover`.
- **Quota**: per-key concurrency + requests per minute + optional daily quota; exceeding it returns an explicit error rather than dropping requests.
- **Health**: `healthy`, `rate_limited`, `cooldown`, `invalid`, `disabled`, `unknown`; each key can be tested or reset individually.

## MCP

**Remote (Streamable HTTP)**

```json
{
  "mcpServers": {
    "search-hub": {
      "type": "http",
      "url": "https://search.example.com/mcp",
      "headers": { "Authorization": "Bearer sh_your_token" }
    }
  }
}
```

> `search.example.com` and `sh_your_token` are placeholders; replace them with your hostname and a real token.

The token needs `mcp:use` and `search`; `get_search_sources` also needs `sources:read` (all three are preselected in the UI). It is shown once when created.

**Local (stdio proxy to the same REST API)**

```json
{
  "mcpServers": {
    "search-hub": {
      "command": "node",
      "args": ["/path/to/search-hub/packages/mcp/dist/stdio.mjs"],
      "env": {
        "SEARCH_HUB_URL": "http://127.0.0.1:8787",
        "SEARCH_HUB_TOKEN": "sh_your_token"
      }
    }
  }
}
```

Tools: `search_web`, `search_multi`, `search_deep`, `search_news`, `search_with_sources`, `search_and_rerank`, `search_and_summarize`, `get_search_sources`, `get_search_status`.

The stdio server proxies REST; stopping the API makes stdio calls fail, proving there is no second search implementation. See [docs/mcp.md](./docs/mcp.md).

## Skills

Three standard `SKILL.md` packages live in `packages/skills/`:

- `search-web` — single search with citation rules
- `deep-research` — multi-query research with synthesis
- `research-with-citations` — an auditable evidence table

Copy them into your agent's skills directory, or download them from **Integrations → Skills**. A skill only needs `SEARCH_HUB_URL` and `SEARCH_HUB_TOKEN`; provider keys never leave the server.

## Custom providers

No code required: **Sources → Add → Generic HTTP/JSON**:

- method, path, headers, query, JSON body (`{{query}}`, `{{key}}`, `{{limit}}`, `{{language}}`, `{{freshness}}`, `{{page}}`)
- key injection (header / query / body, optional prefix)
- results array path (`data.items`) and field mapping (title / url / snippet / publishedAt / score / language)

Mapping is declarative and restricted to safe dotted paths; no user code is executed. See [docs/providers.md](./docs/providers.md).

## Security defaults

- First-run setup requires a real administrator password; no default credentials. Optional `SEARCH_HUB_SETUP_TOKEN`.
- Admin API uses an HttpOnly session cookie with a CSRF header on every mutation; external integrations use revocable, scoped, rate-limited bearer tokens.
- Every outbound request passes SSRF protection: DNS classification, connect-time `lookup` filtering, manual redirect re-validation, and a metadata blocklist. Internal services require an explicit admin allowlist.
- Logs redact `authorization`, `cookie`, `apiKey`, `password`, and `token`; keys never appear in API responses, exports, or logs.
- Retrieved content is always passed to models as untrusted data, with an explicit boundary and injection pattern detection.
- Production responses carry CSP, `X-Frame-Options: DENY`, `nosniff`, and related headers.

See [SECURITY.md](./SECURITY.md). Report vulnerabilities privately.

## Verification

**Automated (reproducible in this repo)**

- 471 unit/integration tests covering the three quota tiers (concurrency/RPM/daily), a 429/401/5xx/timeout/malformed matrix (50 runs each), dedupe, hand-computed RRF, SSRF (direct, proxied, and IPv4-mapped IPv6), a three-way secret leak scan, provider contracts, model chain security, MCP over both transports with the official client, 100 concurrent searches, online-backup consistency under writes, and restart persistence.
- A 16-row acceptance matrix (PASS 11 / PARTIAL 4 / BLOCKED 1) generated from `docs/ac-matrix.json`: [docs/ac-matrix.md](./docs/ac-matrix.md).
- `tests/scripts/smoke.sh`: setup → two sources → test → key → multi-source search → failure isolation → token → MCP initialize.
- Playwright: first-run, login, add source, search lab, theme, settings, integrations.

**Not verified (requires credentials or infrastructure)**

- Brave: no subscription key; no live call to `api.search.brave.com`.
- SearXNG: no self-hosted instance.
- AI / embedding / rerank: no vendor keys; request/response contracts tested against local mock servers only.
- Multi-instance: Redis coordination is not implemented; quotas are guaranteed per process.

These limits are repeated in [docs/testing.md](./docs/testing.md) and release notes.

## Known limitations

- **SQLite only** — PostgreSQL is not implemented. Data access is isolated in `packages/db` and the service layer.
- **Single-instance quota** — key concurrency and RPM state live in memory. A crash can lose the current 60-second window and in-flight counts; startup recalibrates approximately from the day's events. `kill -9` is not covered by the hard quota guarantee.
- **No persistent vector index** — embeddings re-score results within one request.
- **No multi-tenancy** — one administrator, no team permissions.
- **In-process rate limiting** — multiple replicas would each enforce their own limits.

## Layout

```
apps/api          Fastify: REST, admin API, MCP mount, static web
apps/web          React + Vite + Tailwind admin UI
packages/shared   Types, Zod contracts, URL canonicalization, SSRF-safe fetch
packages/db       Drizzle schema, SQL migrations, SQLite client
packages/core     KeyScheduler, fan-out, dedupe, RRF, error classification
packages/providers Provider registry, catalog, Tavily/Bocha/Brave/SearXNG/Generic/Mock
packages/models   Chat / embedding / rerank adapters, summary, injection guard
packages/mcp      MCP v2 server (HTTP + stdio)
packages/skills   Three SKILL.md packages
docs              Architecture, API, MCP, Skills, providers, deployment, testing
tests             unit / integration / e2e / scripts
```

## Testing

```bash
pnpm test                    # Vitest: unit + integration
pnpm build && pnpm test:e2e  # Playwright
bash tests/scripts/smoke.sh http://127.0.0.1:8787
```

Layers, coverage, and gaps: [docs/testing.md](./docs/testing.md).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). A new provider must ship with: an official documentation link, error mapping, mock tests, and an honest live-verification status.

## License

[MIT](./LICENSE)
