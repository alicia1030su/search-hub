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
