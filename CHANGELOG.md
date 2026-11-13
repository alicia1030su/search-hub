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

## [0.1.2] - 2026-11-13

Security and release-readiness pass. The theme is "prove it or mark it blocked":
proxy egress gets an explicit trust boundary, database snapshots use the SQLite
online backup API, and the acceptance matrix is generated from evidence instead
of being counted by hand.

### Added

- **Outbound proxy support with a default-deny trust model.**
  `SEARCH_HUB_OUTBOUND_PROXY` / `SEARCH_HUB_OUTBOUND_NO_PROXY` /
  `SEARCH_HUB_OUTBOUND_PROXY_TRUST` (plus an explicit
  `SEARCH_HUB_OUTBOUND_PROXY_FROM_ENV` opt-in for conventional
  `HTTPS_PROXY`/`NO_PROXY`). Only `http://` and `https://` forward proxies
  are accepted. While the proxy is untrusted (default), loopback, RFC1918,
  CGNAT, link-local, `.local`/`localhost` and cloud metadata destinations are
  rejected **before** any proxy request, even if they are on the private host
  allowlist. Proxy credentials are never logged; `/api/health` exposes only
  mode/trust, and the full policy is admin-only at `/api/admin/outbound`.
- **Provider expansion**: Tavily and Bocha adapters implemented strictly from
  their official docs (official endpoint probed with an invalid key to confirm
  reachability and the error envelope), plus a re-audit of Brave and SearXNG.
  All four stay `documented`; Hacker News remains the only `live_tested`
  provider. Per-vendor language/freshness mapping tables are in
  `docs/provider-matrix.md`.
- **Model protocol matrix**: `kind` × `providerType` combinations that cannot
  work (e.g. `embedding` + `cohere`) are rejected at the edge with
  `validation_error` instead of failing at request time.
- **SQLite online backup**: `GET /api/admin/backup` now uses
  `better-sqlite3` `db.backup()` (Online Backup API), normalises the copy to
  `journal_mode=DELETE`, runs `PRAGMA integrity_check`, stamps
  `user_version`, and publishes atomically (a failed or killed backup leaves
  no file under the final name). Added
  `POST /api/admin/backup/verify` (raw `.db` upload, 64 MB cap, header +
  integrity + migration check, temp copy always deleted) and
  `POST /api/admin/maintenance/checkpoint`.
- `tests/scripts/backup-restore.mjs`: end-to-end drill — snapshots under
  concurrent searches, `integrity_check` and ciphertext-only API keys on every
  download, restore into a fresh directory with `master.key`, newer-schema
  refusal at boot (exit code + log assertion), and failure handling.
- `tests/unit/migrate-guard.test.ts` / `tests/integration/backup.test.ts`:
  migration-version refusal, snapshot consistency under 50 concurrent writes,
  verify endpoint (valid/newer/foreign/garbage/oversized/unauthenticated).
- **Newer-schema refusal**: the API refuses to start when `_migrations`
  contains a migration this build does not ship, instead of silently running
  older code against a newer database.
- `scripts/secret-scan.mjs`: working-tree + git-history credential scan with a
  narrow allowlist for test fixtures; fails the release gate on any hit.
- `docs/ac-matrix.json` + `scripts/ac-matrix.mjs`: the single source of truth
  for AC-01…AC-16, exactly 16 rows, one overall status each, with generated
  counts in `docs/ac-matrix.md`.
- `tests/scripts/search-quality.mjs`: repeatable quality harness (Chinese
  current affairs, English tech, exact phrase, recent) reporting per-source
  counts, valid/unique URLs, duplicate rate, latency and failures without
  subjective ranking.
- `docs/provider-matrix.md`, `docs/provider-plugin-guide.md`,
  `docs/release-checklist.md`, GitHub issue/PR templates.

### Fixed

- **IPv4-mapped IPv6 SSRF bypass**: `http://[::ffff:127.0.0.1]/` and
  `[::ffff:169.254.169.254]` were not recognised as blocked because the URL
  parser normalises the host to `::ffff:7f00:1`. The address guard now decodes
  the hexadecimal mapped form.
- **Blocked destinations were reported as `auth_invalid`**: a
  `SearchHubError("blocked")` hit the generic HTTP-status mapper and became a
  credential error, which could mark a key invalid and mislead operators. The
  provider HTTP layer now passes `blocked` / `bad_request` / `unsupported`
  through unchanged.
- **Database snapshot raced concurrent writers**: replacing
  `wal_checkpoint + readFile` with the Online Backup API removes the window
  where a writer could append to the WAL after the checkpoint.
- Proxy 407/502 errors are mapped to explicit, credential-free messages instead
  of a generic `network` error.
- **Model credentials could surface through vendor error bodies.** Gemini sends
  its key as `x-goog-api-key`, which `SafeFetch`'s header redaction list does not
  cover, so an upstream (or a proxy in front of it) that echoed that header put
  the plaintext key into `model_configs.last_test_error` — and therefore into
  `/api/admin/models`, `/api/admin/backup` snapshots and search
  `stats.errors[].message`. Every model adapter now scrubs its own key (and the
  known credential shapes) before an error leaves it, and the model test endpoint
  scrubs again before persisting. Covered by
  `tests/integration/model-security.test.ts`.
- **A model Base URL that can never work is now refused at save time.**
  Private / reserved / metadata destinations were stored successfully and only
  failed later as a silently degraded search. `POST /api/admin/models` and
  `PATCH /api/admin/models/:id` now reject them with `blocked` and an actionable
  message unless the host is on `settings.security.privateHostAllowlist`; the
  runtime check is unchanged and still applies per request (and to configs
  imported through `/api/admin/config/import`).
- **A degraded model stage lost its timing metric.** `withWarning` wrote
  `rerankMs` / `embeddingMs` / `summaryMs` onto `stats` instead of
  `stats.timing`, so the UI, the types and the dashboards always read
  `undefined` on the failure path. The elapsed time is now recorded where it is
  read.

### Changed

- All workspace packages and the API version are `0.1.2`.
- **Unimplemented provider types now return `400 not_implemented`** instead of
  `501 unsupported`: AC-14 explicitly requires a 4xx with a code, and a 501 is
  a server error that looks like a bug.
- **Model key masks are first-4 + last-4** instead of last-4 only, so two keys
  with the same suffix are distinguishable (AC-03).
- Provider count is now 7 implemented adapters (Brave, SearXNG, Hacker News,
  Tavily, Bocha, Generic HTTP, Mock); the catalog stays at 27 entries and the
  "catalog entry ≠ available adapter" rule is unchanged.
- `docs/acceptance-report.md` now defers the AC tally to the generated
  `docs/ac-matrix.md`; the matrix is the only place statuses are counted.

### Known limitations

- **Docker image build / Compose / container restart remain BLOCKED** in this
  environment: `com.docker.service` cannot be started without administrator
  rights and `wsl.exe` is blocked by the host security policy. A Linux/CI
  verification workflow and script are provided; they have not run here.
- **Tavily / Bocha / Brave / SearXNG are `documented`, not `live_tested`**:
  no keys or reachable instance were available. Contract tests do not prove a
  vendor account works.
- **Proxy mode cannot pin the destination IP**: with an HTTP proxy the proxy
  resolves the target, so a DNS-rebinding race is theoretically possible unless
  the operator declares `trusted-networks` and enforces egress control at the
  proxy.
- Agent Skills still have no real agent-client execution evidence.
- **AC-05 elapsed-time budget is PARTIAL**: the invariant parts (per-key peak,
  RPM window, daily quota, queue timeout) hold, and the scheduler-level budget
  lands at ratio 0.97–1.06, but the end-to-end 100-request burst measured
  1.22–1.30 on a loaded host. The claim is not upgraded.
- **AC-14 rejected-types path is fixed, but the source of the 501 was shared**
  with `unsupported` (still 501 for genuinely unsupported protocol requests).

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
