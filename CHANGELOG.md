# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned

- PostgreSQL support behind the existing repository boundary.
- Redis-backed key scheduling for multi-instance deployments.
- Persistent embedding index (vector store) for document retrieval.
- Additional verified provider adapters (only after a recorded live test).
- SSE streaming for summaries and long-running deep research.

## [0.1.1] - 2026-11-13

Production-readiness pass: the main fixes are the ones that only show up when
the service actually talks to a real network or a clean production install.

### Fixed

- **Every real outbound HTTP call failed on Node 22.** The guarded DNS
  `lookup` returned a single address while `autoSelectFamily` requests the
  `all: true` array form, so provider calls died with
  `ERR_INVALID_IP_ADDRESS`. The lookup now honours both callback shapes, and
  the guarded dispatcher is covered by a regression test that hits a real
  local server.
- **First-run administrator preemption.** A fresh instance could be claimed by
  anyone who reached the port. It now always requires a one-time setup token:
  `SEARCH_HUB_SETUP_TOKEN` when set, otherwise a generated
  `<data>/setup-token` (0600) printed once to the log and deleted after
  initialization. Admin creation runs in a `BEGIN IMMEDIATE` transaction, so
  two concurrent setup requests cannot create two administrators.
- **MCP Host validation.** Only `Origin` was checked and the host comparison
  was self-referential, which left DNS rebinding open. Host and Origin are now
  validated before authentication against IP literals, `localhost`,
  `SEARCH_HUB_PUBLIC_URL` and `SEARCH_HUB_ALLOWED_HOSTS`; rejected requests
  get 403 without revealing whether a token is valid.
- **Reverse-proxy trust boundary.** `SEARCH_HUB_TRUST_PROXY=true` used to
  trust every peer, allowing `X-Forwarded-For` spoofing of login throttling
  and audit attribution. It now trusts only loopback proxies; other networks
  must be listed as explicit CIDRs.
- **Timeout errors were reported as `unknown`.** A per-provider timeout
  aborts through a combined signal whose reason is a plain `Error`; the
  fan-out now maps it to `timeout`. Circuit-breaker short-circuits report
  `circuit_open` instead of a misleading `server_error`.
- **MCP search results dropped provider attribution.** `provider`,
  `providerType`, `providerName` and `source` are now present in tool output.
- **Tokens created in the UI could not list sources.** `sources:read` is now
  offered and preselected; without it `get_search_sources` returned 403.
- **Docker image referenced `apps/web/dist` from the build context** instead
  of the build stage, so a clean `docker build` could not work. The runtime
  stage now copies the web bundle, server bundle, migrations and skills from
  the build stage.
- **`pnpm install --prod` followed by `pnpm build` was impossible** (the
  bundler needs dev dependencies). The documented order is now install →
  build → prod-only install → run the compiled server.
- **Backup guidance lost WAL data.** Copying only `search-hub.db` while the
  service runs drops recent writes; documented `db + -wal + -shm`, and added
  `GET /api/admin/backup` which checkpoints first.

### Added

- Hacker News adapter over the official Algolia API (keyless), **live-tested**
  through REST and MCP with real URLs and timestamps.
- `POST /api/admin/migration/legacy`: dry-run/apply migration of an older
  Search Hub provider list. It never reads or stores credentials, never
  overwrites existing names, and requires an explicit confirmation string.
- `GET /api/admin/backup` and `POST /api/admin/maintenance/checkpoint`.
- `skipCache` on `POST /api/search`; the search lab always sets it.
- `stats.degraded` on responses when an optional model stage fails.
- `queue_timeout` and `circuit_open` error codes.
- `peakInFlight` in key runtime snapshots (used by the quota tests).
- Production build: `scripts/build-server.mjs` emits
  `apps/api/dist/server.mjs` and `packages/mcp/dist/stdio.mjs`; the runtime no
  longer needs `tsx` or TypeScript sources.
- Verification scripts: `leak-scan.mjs`, `mcp-live.mjs`, `live-search.mjs`,
  `clean-install.mjs`.
- 38 new tests (177 total): three-tier quota peaks, 50-run fault matrix,
  model degradation, setup/Host/CSRF/proxy hardening, official MCP client over
  HTTP and stdio, legacy migration.

### Changed

- `/api/search` returns **503** when every provider fails; partial success
  stays 200 with `stats.partial=true` and `failedSources[]`.
- Documentation reconciled with the code: catalog counts (27 entries, 5
  implemented adapters), queue semantics, timeout defaults, error fields, and
  the fact that caching is implemented but disabled by default.
- Compose uses the named volume `search-hub-data` so the non-root container
  can write without a manual `chown`.

### Known limitations

- Docker image build and container restart could not be executed here: the
  Docker engine is unavailable (the WSL backend is blocked by the host
  security policy). See `docs/acceptance-report.md` for the evidence.
- Brave and SearXNG remain unverified (no key / no reachable instance).
- `kill -9` may lose up to the current 60s quota window; `SIGTERM` performs a
  clean checkpoint and close.

## [0.1.0] - 2026-11-13

First functional release: the full search loop works end to end, with keys,
providers, fusion, admin UI, REST, MCP, and Skills.

### Added

**Core search**

- Multi-provider concurrent fan-out with per-source timeout, global deadline,
  failure isolation, bounded retry budget, and client cancellation.
- URL canonicalization (tracking parameters, default ports, query ordering),
  exact and near-duplicate merging with source attribution, and Reciprocal Rank
  Fusion (`k` configurable, default 60).
- Deterministic `mock` provider with latency and failure injection for tests.

**Key management**

- Per-provider key pools with five scheduling strategies: round-robin, random,
  weighted random, least used, and failover.
- Atomic slot reservation; a bounded wait queue lets bursts queue instead of
  failing immediately while never exceeding the per-key concurrency limit.
- Per-key concurrency, RPM sliding window, optional daily quota, cooldowns,
  circuit breaker, and explicit error codes (`rate_limited`, `auth_invalid`,
  `quota_exceeded`, `no_available_key`, …).
- AES-256-GCM encryption with a master key from env or `data/master.key`;
  masked hints in every response.

**Providers**

- Brave (`X-Subscription-Token`), SearXNG (`/search?format=json`), declarative
  Generic HTTP/JSON, and Mock.
- Honest catalog of 26 entries with implementation and verification status;
  unimplemented entries cannot be created.

**Models (optional)**

- Chat: OpenAI-compatible, Anthropic, Gemini.
- Embeddings: OpenAI-compatible and declarative custom HTTP, with dimension
  validation and batching.
- Rerank: Cohere/Jina-compatible and declarative custom HTTP.
- Cited summaries (`[n]`), query rewriting for deep mode, embedding-based
  re-scoring, prompt-injection detection and untrusted-content boundaries.

**API and integrations**

- REST: `/api/search`, `/api/search/deep`, task inspection/cancel, provider
  catalog/health, dashboard, settings, tokens, logs, export/import.
- OpenAPI 3.1 document at `/api/openapi.json` plus a readable `/api/docs`.
- MCP server on the official v2 SDK (`@modelcontextprotocol/server` 2.4.0):
  modern 2026-07-28 envelope and legacy 2025-11-25 handshake, Streamable HTTP and
  stdio (proxy to REST), nine stable tools, bearer auth with scopes.
- Three Agent Skills: `search-web`, `deep-research`, `research-with-citations`.

**Admin UI**

- React 19 + Vite 8 + Tailwind 4, light/dark themes, Chinese default.
- Dashboard with timeline, provider health, key pool distribution, model stats.
- Provider catalog and forms (including Generic HTTP mapping validation),
  key panel with per-key test/disable/delete, model management with live tests,
  search lab with per-source timing, dedupe counts, fused ranks, rerank rank,
  summary citations, JSON copy/download, integrations and settings.

**Security**

- First-run administrator creation with no default password; scrypt hashing.
- HttpOnly session cookies plus CSRF headers on every admin mutation.
- Revocable, scoped, rate-limited bearer tokens, shown once.
- SSRF protection at DNS, connect, and redirect layers, with a metadata
  blocklist and an explicit private-host allowlist.
- Log redaction, secret-free config export, CSP and hardening headers.

**Operations**

- SQLite with WAL, ordered SQL migrations applied at boot, automatic retention
  cleanup, graceful shutdown flush.
- Dockerfile, `compose.yaml`, `.env.example`, health check, non-root runtime.
- GitHub Actions: lint, typecheck, unit/integration tests, migration smoke test,
  web build, image build and health check, Playwright E2E, dependency audit.
- Documentation set: architecture, API, MCP, Skills, provider guide, deployment,
  testing, security, product scope.

### Verified in this release

- 139 Vitest unit/integration tests pass.
- Playwright E2E passes (first run, login, providers, lab, theme, settings,
  integrations).
- `tests/scripts/smoke.sh` passes against a live instance.
- Load test: 100 concurrent searches with 2 keys × concurrency 2 complete
  without exceeding the per-key limit or leaking secrets.

### Not verified in this release

- Brave: no real subscription key; adapter tested against a local fixture.
- SearXNG: no live instance.
- AI / embedding / rerank: contracts tested against local mock servers only.
- Docker image build was **not executed** in the development environment
  (Docker daemon unavailable); the Dockerfile and CI job are provided but the
  image has not been built here.
- Multi-instance deployments are unsupported.

### Known limitations

- SQLite only; PostgreSQL is not implemented.
- Key quota state is per process; a crash can lose up to the current 60-second
  window and in-flight counts.
- No persistent vector index; embeddings apply per request.
- Single administrator; no multi-tenancy.
- In-process rate limiting does not coordinate across replicas.
